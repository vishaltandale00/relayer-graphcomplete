import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { extractFile, listPackage } from "@electron/asar";

import { desktopTargetByKey } from "../shared/target.mjs";
import { exactKeys } from "../shared/telemetry-validation.mjs";

const RELEASE_ID_PREFIX = "ai.relayer.desktop@";
const RELEASE_COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const SENTRY_ORGANIZATION = "relayer-labs-llc";
const SENTRY_PROJECT = "graphcomplete-desktop";
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);
const execFileAsync = promisify(execFile);
const MANIFEST_FIELDS = Object.freeze([
  "architecture",
  "candidateChannel",
  "debugArtifacts",
  "nativeDebugIdentities",
  "packagedApplication",
  "platform",
  "release",
  "schema",
  "sourceCommit",
  "sourceMaps",
  "target",
  "version",
]);

function normalizedRelativePath(value) {
  const normalized = String(value || "").split(sep).join("/");
  if (!normalized || isAbsolute(normalized) || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Desktop telemetry artifact path must be repository-relative.");
  }
  return normalized;
}

function releaseIdentity(contract) {
  let target;
  try {
    target = desktopTargetByKey(contract?.targetKey);
  } catch {
    target = null;
  }
  if (!contract?.release
    || (contract.channelName !== "preview" && contract.channelName !== "stable")
    || !/^\d+\.\d+\.\d+$/u.test(contract.version)
    || !RELEASE_COMMIT_PATTERN.test(contract.sourceCommit)
    || !contract.targetKey
    || !contract.distributionPlatform
    || !contract.architecture
    || !contract.rustTarget
    || !target
    || contract.platform !== target.platform
    || contract.distributionPlatform !== target.distributionPlatform
    || contract.architecture !== target.architecture
    || contract.rustTarget !== target.rustTarget) {
    throw new Error("Desktop telemetry artifacts require exact Preview or Stable release authority.");
  }
  return `${RELEASE_ID_PREFIX}${contract.version}+${contract.sourceCommit}`;
}

async function filesBelow(root) {
  const entries = [];
  async function visit(directory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const childPath = join(directory, child.name);
      if (child.isDirectory()) await visit(childPath);
      else if (child.isFile()) entries.push(childPath);
    }
  }
  await visit(root);
  return entries;
}

async function hashArtifact(filePath, root) {
  const contents = await readFile(filePath);
  return Object.freeze({
    path: normalizedRelativePath(relative(root, filePath)),
    size: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
}

function identityMappings(lineCount) {
  if (lineCount <= 0) return "";
  return ["AAAA", ...Array.from({ length: lineCount - 1 }, () => "AACA")].join(";");
}

function identitySourceMap(modulePath, source) {
  return {
    version: 3,
    file: modulePath,
    sourceRoot: "",
    sources: [modulePath],
    sourcesContent: [source],
    names: [],
    mappings: identityMappings(source.split("\n").length),
  };
}

function sourceGroupForAsarEntry(entry) {
  const mappings = [
    ["main/", "electron", "desktop/main/"],
    ["preload/", "electron", "desktop/preload/"],
    ["shared/", "electron", "desktop/shared/"],
    ["node_modules/@relayer/graph-client/", "node", "packages/graph-client/"],
    ["node_modules/@relayer/harness-host/", "node", "packages/harness-host/"],
  ];
  for (const [packagedPrefix, component, sourcePrefix] of mappings) {
    if (entry.startsWith(packagedPrefix)) return [component, `${sourcePrefix}${entry.slice(packagedPrefix.length)}`];
  }
  return null;
}

async function defaultSourceGroups(repositoryRoot, packagedApplication, platform) {
  const resources = packagedResourcesPath(packagedApplication, platform);
  const result = [];
  const asarEntries = listPackage(resolve(resources, "app.asar"))
    .map((entry) => String(entry).replaceAll("\\", "/").replace(/^\/+/, ""))
    .sort();
  for (const entry of asarEntries) {
    const extension = entry.slice(entry.lastIndexOf("."));
    if (!SOURCE_EXTENSIONS.has(extension)) continue;
    const sourceGroup = sourceGroupForAsarEntry(entry);
    if (sourceGroup) result.push(sourceGroup);
  }
  const rendererRoot = resolve(resources, "renderer");
  for (const packagedPath of await filesBelow(rendererRoot)) {
    const rendererRelative = normalizedRelativePath(relative(rendererRoot, packagedPath));
    const extension = rendererRelative.slice(rendererRelative.lastIndexOf("."));
    if (!SOURCE_EXTENSIONS.has(extension)
      || (rendererRelative !== "theme-bootstrap.js" && !rendererRelative.startsWith("src/"))) continue;
    result.push(["renderer", `desktop/renderer/${rendererRelative}`]);
  }
  result.sort((left, right) => left[1].localeCompare(right[1]));
  return result;
}

function defaultRustBinaries(repositoryRoot, contract) {
  const suffix = contract.platform === "win32" ? ".exe" : "";
  return ["relayer-app-server", "relayer-graph-server"]
    .map((name) => resolve(repositoryRoot, "target", contract.rustTarget, "release", `${name}${suffix}`));
}

async function defaultExecute(command, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}

async function defaultCapture(command, args, options = {}) {
  return execFileAsync(command, args, { ...options, encoding: "utf8" });
}

function packagedResourcesPath(packagedApplication, platform) {
  return platform === "darwin"
    ? resolve(packagedApplication, "Contents", "Resources")
    : resolve(packagedApplication, "resources");
}

function packagedAsarEntry(modulePath) {
  const mappings = [
    ["desktop/main/", "main/"],
    ["desktop/preload/", "preload/"],
    ["desktop/shared/", "shared/"],
    ["packages/graph-client/", "node_modules/@relayer/graph-client/"],
    ["packages/harness-host/", "node_modules/@relayer/harness-host/"],
  ];
  for (const [sourcePrefix, packagedPrefix] of mappings) {
    if (modulePath.startsWith(sourcePrefix)) return `${packagedPrefix}${modulePath.slice(sourcePrefix.length)}`;
  }
  return null;
}

async function readPackagedSource({ packagedApplication, platform, modulePath }) {
  const resources = packagedResourcesPath(packagedApplication, platform);
  if (modulePath.startsWith("desktop/renderer/")) {
    return readFile(resolve(resources, "renderer", modulePath.slice("desktop/renderer/".length)));
  }
  const entry = packagedAsarEntry(modulePath);
  if (!entry) throw new Error(`Desktop telemetry has no packaged source mapping for ${modulePath}.`);
  try {
    return extractFile(resolve(resources, "app.asar"), entry);
  } catch {
    throw new Error(`Desktop telemetry packaged source is missing: ${modulePath}.`);
  }
}

function parseMacDebugIds(output) {
  return [...String(output || "").matchAll(/UUID:\s*([a-f0-9-]{36})\s*\(/giu)]
    .map((match) => match[1].toLowerCase())
    .sort();
}

function parseWindowsDebugId(output) {
  const text = String(output || "");
  const guid = /(?:PDB)?GUID:\s*[({]?([a-f0-9-]{36})[)}]?/iu.exec(text)?.[1]?.toLowerCase();
  const age = /(?:PDB)?Age:\s*(\d+)/iu.exec(text)?.[1];
  return guid && age ? `${guid}-${age}` : null;
}

async function correlateNativeDebugIdentity({ contract, resources, sourceBinary, debugPath, capture }) {
  const packagedBinary = resolve(resources, "bin", basename(sourceBinary));
  if (contract.platform === "darwin") {
    const [packaged, debug] = await Promise.all([
      capture("/usr/bin/dwarfdump", ["--uuid", packagedBinary]),
      capture("/usr/bin/dwarfdump", ["--uuid", debugPath]),
    ]);
    const packagedIds = parseMacDebugIds(packaged.stdout);
    const debugIds = parseMacDebugIds(debug.stdout);
    if (packagedIds.length === 0 || JSON.stringify(packagedIds) !== JSON.stringify(debugIds)) {
      throw new Error("Desktop telemetry dSYM UUID does not match the packaged Rust executable.");
    }
    return { packagedBinary, debugId: packagedIds.join(",") };
  }
  const [packaged, debug] = await Promise.all([
    capture("llvm-readobj", ["--coff-debug-directory", packagedBinary]),
    capture("llvm-pdbutil", ["dump", "-summary", debugPath]),
  ]);
  const packagedId = parseWindowsDebugId(packaged.stdout);
  const debugId = parseWindowsDebugId(debug.stdout);
  if (!packagedId || packagedId !== debugId) {
    throw new Error("Desktop telemetry PDB identity does not match the packaged Rust executable.");
  }
  return { packagedBinary, debugId };
}

export async function prepareDesktopTelemetryArtifacts({
  contract,
  repositoryRoot = resolve(import.meta.dirname, "../.."),
  outputRoot = resolve(repositoryRoot, "desktop/dist/telemetry"),
  packagedApplication,
  sourceGroups,
  rustBinaries,
  execute = defaultExecute,
  capture = defaultCapture,
} = {}) {
  const release = releaseIdentity(contract);
  const distRoot = resolve(repositoryRoot, "desktop/dist");
  const packagedRelative = normalizedRelativePath(relative(distRoot, packagedApplication));
  if (packagedRelative.startsWith("telemetry/")) throw new Error("Packaged application path is invalid.");
  const selectedSources = sourceGroups ?? await defaultSourceGroups(repositoryRoot, packagedApplication, contract.platform);
  const selectedRustBinaries = rustBinaries ?? defaultRustBinaries(repositoryRoot, contract);
  const sourceMapsRoot = resolve(outputRoot, "source-maps");
  const debugRoot = resolve(outputRoot, "debug");
  const resources = packagedResourcesPath(packagedApplication, contract.platform);
  await mkdir(sourceMapsRoot, { recursive: true, mode: 0o755 });
  await mkdir(debugRoot, { recursive: true, mode: 0o755 });

  const sourceMaps = [];
  for (const [component, rawModulePath] of [...selectedSources].sort((left, right) => left[1].localeCompare(right[1]))) {
    if (!new Set(["electron", "renderer", "node"]).has(component)) {
      throw new Error("Desktop telemetry source-map component is invalid.");
    }
    const modulePath = normalizedRelativePath(rawModulePath);
    const sourcePath = resolve(repositoryRoot, modulePath);
    const sourceBytes = await readFile(sourcePath);
    const packagedBytes = await readPackagedSource({ packagedApplication, platform: contract.platform, modulePath });
    if (!sourceBytes.equals(packagedBytes)) {
      throw new Error(`Desktop telemetry packaged source bytes do not match ${modulePath}.`);
    }
    const source = sourceBytes.toString("utf8");
    const artifactSourcePath = resolve(sourceMapsRoot, modulePath);
    const artifactMapPath = `${artifactSourcePath}.map`;
    await mkdir(dirname(artifactSourcePath), { recursive: true, mode: 0o755 });
    await writeFile(artifactSourcePath, sourceBytes, { mode: 0o644 });
    await writeFile(artifactMapPath, `${JSON.stringify(identitySourceMap(modulePath, source))}\n`, { encoding: "utf8", mode: 0o644 });
    const [sourceArtifact, mapArtifact] = await Promise.all([
      hashArtifact(artifactSourcePath, outputRoot),
      hashArtifact(artifactMapPath, outputRoot),
    ]);
    sourceMaps.push(Object.freeze({ component, module: modulePath, ...mapArtifact, source: sourceArtifact }));
  }

  const nativeDebugIdentities = [];
  if (contract.platform === "darwin") {
    for (const binary of selectedRustBinaries) {
      const destination = resolve(debugRoot, `${basename(binary)}.dSYM`);
      await execute("dsymutil", [binary, "-o", destination], { cwd: repositoryRoot });
      const identity = await correlateNativeDebugIdentity({ contract, resources, sourceBinary: binary, debugPath: destination, capture });
      nativeDebugIdentities.push({
        binary: normalizedRelativePath(relative(resources, identity.packagedBinary)),
        debug: normalizedRelativePath(relative(outputRoot, destination)),
        debugId: identity.debugId,
      });
    }
  } else if (contract.platform === "win32") {
    for (const binary of selectedRustBinaries) {
      const stem = basename(binary).replace(/\.exe$/iu, "");
      const destination = resolve(debugRoot, `${stem}.pdb`);
      await copyFile(resolve(dirname(binary), `${stem}.pdb`), destination);
      const identity = await correlateNativeDebugIdentity({ contract, resources, sourceBinary: binary, debugPath: destination, capture });
      nativeDebugIdentities.push({
        binary: normalizedRelativePath(relative(resources, identity.packagedBinary)),
        debug: normalizedRelativePath(relative(outputRoot, destination)),
        debugId: identity.debugId,
      });
    }
  } else {
    throw new Error("Desktop telemetry debug artifacts require a supported release target.");
  }
  const debugArtifacts = await Promise.all((await filesBelow(debugRoot)).map((filePath) => hashArtifact(filePath, outputRoot)));
  debugArtifacts.sort((left, right) => left.path.localeCompare(right.path));
  if (sourceMaps.length === 0 || debugArtifacts.length === 0) {
    throw new Error("Desktop telemetry release artifacts must include source maps and Rust debug data.");
  }

  const manifest = {
    schema: "relayer.desktop-telemetry-artifacts/v1",
    release,
    version: contract.version,
    sourceCommit: contract.sourceCommit,
    candidateChannel: contract.channelName,
    target: contract.targetKey,
    platform: contract.distributionPlatform,
    architecture: contract.architecture,
    packagedApplication: packagedRelative,
    sourceMaps,
    debugArtifacts,
    nativeDebugIdentities,
  };
  await writeFile(resolve(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
  return manifest;
}

async function verifyEntry(entry, outputRoot) {
  if (!exactKeys(entry, ["path", "sha256", "size"])
    || typeof entry.path !== "string" || !Number.isSafeInteger(entry.size) || !/^[a-f0-9]{64}$/u.test(entry.sha256)) {
    throw new Error("Desktop telemetry artifact manifest entry is invalid.");
  }
  const actual = await hashArtifact(resolve(outputRoot, normalizedRelativePath(entry.path)), outputRoot);
  if (actual.size !== entry.size || actual.sha256 !== entry.sha256) {
    throw new Error(`Desktop telemetry artifact does not match its manifest: ${entry.path}.`);
  }
}

function validateManifestShape(manifest) {
  let target;
  try {
    target = desktopTargetByKey(manifest?.target);
  } catch {
    target = null;
  }
  const artifactShape = (entry) => exactKeys(entry, ["path", "sha256", "size"])
    && typeof entry.path === "string"
    && Number.isSafeInteger(entry.size)
    && entry.size > 0
    && /^[a-f0-9]{64}$/u.test(entry.sha256);
  const sourceMapsValid = Array.isArray(manifest?.sourceMaps)
    && manifest.sourceMaps.length > 0
    && manifest.sourceMaps.every((entry) => exactKeys(entry, ["component", "module", "path", "sha256", "size", "source"])
      && new Set(["electron", "renderer", "node"]).has(entry.component)
      && typeof entry.module === "string"
      && entry.path === `source-maps/${entry.module}.map`
      && Number.isSafeInteger(entry.size)
      && entry.size > 0
      && /^[a-f0-9]{64}$/u.test(entry.sha256)
      && artifactShape(entry.source)
      && entry.source.path === `source-maps/${entry.module}`);
  const debugArtifactsValid = Array.isArray(manifest?.debugArtifacts)
    && manifest.debugArtifacts.length > 0
    && manifest.debugArtifacts.every(artifactShape);
  const identitiesValid = Array.isArray(manifest?.nativeDebugIdentities)
    && manifest.nativeDebugIdentities.length > 0
    && manifest.nativeDebugIdentities.every((entry) => exactKeys(entry, ["binary", "debug", "debugId"])
      && /^bin\/relayer-(?:app|graph)-server(?:\.exe)?$/u.test(entry.binary)
      && entry.debug.startsWith("debug/")
      && /^[a-f0-9,-]{36,80}$/u.test(entry.debugId)
      && manifest.debugArtifacts.some((artifact) => (
        artifact.path === entry.debug || artifact.path.startsWith(`${entry.debug}/`)
      )));
  let packagedApplicationValid = false;
  try {
    packagedApplicationValid = normalizedRelativePath(manifest?.packagedApplication) === manifest.packagedApplication;
  } catch {}
  return exactKeys(manifest, MANIFEST_FIELDS)
    && target
    && manifest.platform === target.distributionPlatform
    && manifest.architecture === target.architecture
    && manifest.release === `${RELEASE_ID_PREFIX}${manifest.version}+${manifest.sourceCommit}`
    && /^\d+\.\d+\.\d+$/u.test(manifest.version)
    && RELEASE_COMMIT_PATTERN.test(manifest.sourceCommit)
    && (manifest.candidateChannel === "preview" || manifest.candidateChannel === "stable")
    && packagedApplicationValid
    && sourceMapsValid
    && debugArtifactsValid
    && identitiesValid;
}

export async function verifyDesktopTelemetryArtifacts({ outputRoot } = {}) {
  const manifest = JSON.parse(await readFile(resolve(outputRoot, "manifest.json"), "utf8"));
  if (manifest?.schema !== "relayer.desktop-telemetry-artifacts/v1" || !validateManifestShape(manifest)) {
    throw new Error("Desktop telemetry artifact manifest is invalid.");
  }
  for (const entry of manifest.sourceMaps) {
    await verifyEntry({ path: entry.path, size: entry.size, sha256: entry.sha256 }, outputRoot);
    await verifyEntry(entry.source, outputRoot);
  }
  for (const entry of manifest.debugArtifacts) await verifyEntry(entry, outputRoot);
  return manifest;
}

function requiredEnvironment(environment, name) {
  const value = String(environment?.[name] || "").trim();
  if (!value) throw new Error(`Desktop telemetry upload requires ${name}.`);
  return value;
}

export function createDesktopTelemetryUploadPlan({ manifest, environment = process.env, artifactsRoot } = {}) {
  if (manifest?.schema !== "relayer.desktop-telemetry-artifacts/v1" || !validateManifestShape(manifest)) {
    let target = null;
    try { target = desktopTargetByKey(manifest?.target); } catch {}
    if (target && (manifest?.platform !== target.distributionPlatform || manifest?.architecture !== target.architecture)) {
      throw new Error("Desktop telemetry upload target tuple is invalid.");
    }
    throw new Error("Desktop telemetry artifact manifest is invalid.");
  }
  if (environment.CI !== "true" || environment.GITHUB_ACTIONS !== "true" || environment.RELAYER_DESKTOP_RELEASE !== "1") {
    throw new Error("Desktop telemetry upload requires GitHub Actions release authority.");
  }
  const channel = requiredEnvironment(environment, "RELAYER_DESKTOP_CHANNEL");
  if (channel !== "preview" && channel !== "stable") {
    throw new Error("Desktop telemetry upload requires Preview or Stable release authority.");
  }
  const sourceCommit = requiredEnvironment(environment, "RELAYER_DESKTOP_SOURCE_COMMIT");
  if (sourceCommit !== manifest?.sourceCommit || requiredEnvironment(environment, "GITHUB_SHA") !== sourceCommit) {
    throw new Error("Desktop telemetry upload source commit does not match the candidate.");
  }
  if (requiredEnvironment(environment, "RELAYER_DESKTOP_TARGET") !== manifest.target) {
    throw new Error("Desktop telemetry upload target does not match the candidate.");
  }
  requiredEnvironment(environment, "SENTRY_AUTH_TOKEN");
  const organization = requiredEnvironment(environment, "SENTRY_ORG");
  const project = requiredEnvironment(environment, "SENTRY_PROJECT");
  if (organization !== SENTRY_ORGANIZATION || project !== SENTRY_PROJECT) {
    throw new Error("Desktop telemetry upload target is not the approved Sentry project.");
  }
  const sentryCliBinary = requiredEnvironment(environment, "SENTRY_CLI_BINARY");
  if (!isAbsolute(sentryCliBinary) || !/(?:^|[/\\])sentry-cli(?:\.cmd)?$/u.test(sentryCliBinary)) {
    throw new Error("Desktop telemetry upload requires the absolute pinned Sentry CLI binary.");
  }
  if (manifest.release !== `${RELEASE_ID_PREFIX}${manifest.version}+${sourceCommit}`
    || (manifest.candidateChannel !== "preview" && manifest.candidateChannel !== "stable")) {
    throw new Error("Desktop telemetry upload release identity is invalid.");
  }
  const prefix = ["--org", organization, "--project", project];
  return Object.freeze([
    Object.freeze({ command: sentryCliBinary, args: Object.freeze([...prefix, "releases", "new", manifest.release]) }),
    Object.freeze({ command: sentryCliBinary, args: Object.freeze([...prefix, "sourcemaps", "upload", "--release", manifest.release, "--url-prefix", "", "--validate", "--strict", "--wait", resolve(artifactsRoot, "source-maps")]) }),
    Object.freeze({ command: sentryCliBinary, args: Object.freeze([...prefix, "debug-files", "upload", "--include-sources", "--wait", resolve(artifactsRoot, "debug")]) }),
    Object.freeze({ command: sentryCliBinary, args: Object.freeze([...prefix, "releases", "finalize", manifest.release]) }),
  ]);
}

export async function assertCredentialAbsentFromTree({ root, credential } = {}) {
  if (typeof credential !== "string" || credential.length < 8) {
    throw new Error("Desktop telemetry package audit requires the CI upload credential.");
  }
  const needle = Buffer.from(credential);
  for (const filePath of await filesBelow(root)) {
    let previous = Buffer.alloc(0);
    for await (const chunk of createReadStream(filePath)) {
      const bytes = Buffer.concat([previous, chunk]);
      if (bytes.includes(needle)) {
        throw new Error("Desktop telemetry upload credential is present in packaged application bytes.");
      }
      previous = bytes.subarray(Math.max(0, bytes.length - needle.length + 1));
    }
  }
}

export async function runDesktopTelemetryUpload({
  repositoryRoot = resolve(import.meta.dirname, "../.."),
  environment = process.env,
  execute = defaultExecute,
} = {}) {
  const artifactsRoot = resolve(repositoryRoot, "desktop/dist/telemetry");
  const manifest = await verifyDesktopTelemetryArtifacts({ outputRoot: artifactsRoot });
  const plan = createDesktopTelemetryUploadPlan({ manifest, environment, artifactsRoot });
  await assertCredentialAbsentFromTree({
    root: resolve(repositoryRoot, "desktop/dist", normalizedRelativePath(manifest.packagedApplication)),
    credential: requiredEnvironment(environment, "SENTRY_AUTH_TOKEN"),
  });
  for (const step of plan) await execute(step.command, step.args, { cwd: repositoryRoot, env: environment });
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await runDesktopTelemetryUpload();
  console.log(JSON.stringify({ ok: true, release: manifest.release, target: manifest.target }, null, 2));
}
