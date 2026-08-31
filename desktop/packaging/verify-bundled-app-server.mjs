import { execFile } from "node:child_process";
import { extractFile, listPackage } from "@electron/asar";
import { access, chmod, lstat, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import * as tar from "tar";

import { desktopTargetFromEnvironment } from "../shared/target.mjs";
import { PACKAGED_PROVIDER_MODULES } from "../main/providers/provider-adapter-registry.mjs";
import {
  CODEX_BROWSER_MCP_ENTRY,
  CODEX_BROWSER_MCP_PACKAGE,
  CODEX_BROWSER_MCP_VERSION,
} from "../main/services/codex-browser-mcp-runtime.mjs";
import { validatePrimeAgentManifest } from "../main/services/prime-agent-runtime.mjs";
import {
  digestFileEntries,
  digestFilesystemTree,
  dependencyInstallCandidates,
  createSignedDependencyClosureSnapshot,
  primeRuntimeSourcePathIsPackaged,
  runtimeDependencyRequirements,
  runtimeDependencyFileIsPackaged,
  runtimePackageMetadataDigest,
  sha256,
  verifySignedDependencyClosureSnapshot,
} from "../shared/prime-runtime-integrity.mjs";

const execFileAsync = promisify(execFile);

function normalizeAsarEntry(entry) {
  return String(entry).replaceAll("\\", "/").replace(/^\/+/, "");
}

export function asarEntryPath(entry, platform = process.platform) {
  const normalized = normalizeAsarEntry(entry);
  return platform === "win32" ? normalized.replaceAll("/", "\\") : normalized;
}

export async function verifyBundledAppServer(
  appPath,
  {
    execute = execFileAsync,
    platform = "darwin",
    expectedArchitecture = process.arch === "x64" ? "x86_64" : process.arch,
    listPackageEntries = listPackage,
    verifyPrimeAgent = verifyPackagedPrimeAgent,
    primeAgentTargetKey = `${platform}-${expectedArchitecture === "x86_64" ? "x64" : expectedArchitecture}`,
    primeAgentIntegrityPhase = "unsigned",
  } = {},
) {
  const resourcesPath = platform === "darwin" ? join(appPath, "Contents", "Resources") : join(appPath, "resources");
  const binarySuffix = platform === "win32" ? ".exe" : "";
  const binaryPath = join(resourcesPath, "bin", `relayer-app-server${binarySuffix}`);
  const graphBinaryPath = join(resourcesPath, "bin", `relayer-graph-server${binarySuffix}`);
  const graphClientPath = join(resourcesPath, "graph-client", "index.js");
  const markedPath = join(resourcesPath, "renderer", "vendor", "marked.umd.js");
  await Promise.all([access(binaryPath), access(graphBinaryPath), access(graphClientPath), access(markedPath)]);
  const packagedEntries = new Set(listPackageEntries(join(resourcesPath, "app.asar")).map(normalizeAsarEntry));
  for (const entry of [
    "main/single-instance.mjs",
    "main/services/codex-browser-mcp-runtime.mjs",
    "node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
    "node_modules/@relayer/graph-client/dist/index.js",
    "node_modules/@relayer/harness-host/dist/index.js",
    "node_modules/@relayer/harness-host/dist/implementations/claude-basic-browser.js",
    "node_modules/@relayer/eval-runner/dist/index.js",
  ]) {
    if (!packagedEntries.has(entry)) throw new Error(`Bundled Relayer runtime is missing ${entry}.`);
  }
  await verifyPackagedCodexBrowserMcp(resourcesPath);
  await verifyPrimeAgent(resourcesPath, packagedEntries, {
    integrityPhase: primeAgentIntegrityPhase,
    targetKey: primeAgentTargetKey,
  });
  let architectures = null;
  if (platform === "darwin") {
    for (const [label, executable] of [["app server", binaryPath], ["graph server", graphBinaryPath]]) {
      const result = await execute("/usr/bin/lipo", ["-archs", executable]);
      architectures = String(result.stdout || "").trim();
      if (architectures !== expectedArchitecture) {
        throw new Error(
          `Bundled Relayer ${label} must contain only ${expectedArchitecture} executable code; found ${architectures || "unknown"}.`,
        );
      }
    }
  }
  return { binaryPath, architecture: architectures };
}

export async function verifyPackagedCodexBrowserMcp(resourcesPath) {
  const packageRoot = join(resourcesPath, "app.asar.unpacked", "node_modules", CODEX_BROWSER_MCP_PACKAGE);
  const manifestPath = join(packageRoot, "package.json");
  const scriptPath = join(packageRoot, CODEX_BROWSER_MCP_ENTRY);
  const [manifestBytes, manifestStat, scriptStat] = await Promise.all([
    readFile(manifestPath, "utf8"),
    stat(manifestPath),
    stat(scriptPath),
  ]);
  if (!manifestStat.isFile() || !scriptStat.isFile()) {
    throw new Error("Bundled Codex browser helper files are invalid.");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes);
  } catch {
    throw new Error("Bundled Codex browser helper manifest is invalid.");
  }
  if (manifest?.name !== CODEX_BROWSER_MCP_PACKAGE || manifest?.version !== CODEX_BROWSER_MCP_VERSION) {
    throw new Error(`Bundled Codex browser helper must be ${CODEX_BROWSER_MCP_PACKAGE}@${CODEX_BROWSER_MCP_VERSION}.`);
  }
  return { packageRoot, scriptPath };
}

export async function verifyPackagedPrimeAgent(
  resourcesPath,
  packagedEntries = new Set(listPackage(join(resourcesPath, "app.asar")).map(normalizeAsarEntry)),
  {
    extractPackageFile = (archivePath, entry) => extractFile(archivePath, asarEntryPath(entry)),
    vendorDirectory = resolve(import.meta.dirname, "../../vendor/prime-agent"),
    verifyDependencyClosure = digestAsarDependencyClosure,
    collectDependencyClosure = collectAsarDependencyClosureEntries,
    readSignedClosureSnapshot = () => readFile(join(resourcesPath, "prime-agent", "signing-closure.json"), "utf8")
      .then((bytes) => JSON.parse(bytes)),
    targetKey = `${process.platform}-${process.arch}`,
    integrityPhase = "unsigned",
  } = {},
) {
  if (integrityPhase !== "unsigned" && integrityPhase !== "signed") {
    throw new Error(`Unsupported bundled Prime Agent integrity phase: ${integrityPhase}.`);
  }
  const manifest = JSON.parse(await readFile(join(resourcesPath, "prime-agent", "manifest.json"), "utf8"));
  validatePrimeAgentManifest(manifest);
  const requiredResources = [
    ...manifest.harnessConfigurations.map((name) => join(resourcesPath, "harnesses", name)),
    join(resourcesPath, "python", "relayer-graph", "src", manifest.pythonPackage, "__init__.py"),
  ];
  await Promise.all(requiredResources.map((path) => access(path)));
  for (const name of manifest.harnessConfigurations) {
    const digest = sha256(await readFile(join(resourcesPath, "harnesses", name)));
    if (digest !== manifest.assets.harnessConfigurations[name]) {
      throw new Error(`Bundled Prime Agent harness integrity mismatch for ${name}.`);
    }
  }
  const pythonPackageRoot = join(resourcesPath, "python", "relayer-graph", "src", manifest.pythonPackage);
  const pythonDigest = await digestFilesystemTree(pythonPackageRoot, (path) => path.endsWith(".py"));
  if (pythonDigest !== manifest.assets.pythonPackageTreeSha256) {
    throw new Error("Bundled Prime Agent Python client integrity mismatch.");
  }
  const asarPath = join(resourcesPath, "app.asar");
  const directoryEntries = new Set();
  for (const path of packagedEntries) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directoryEntries.add(segments.slice(0, index).join("/"));
    }
  }
  const packagedFileEntries = [...packagedEntries].filter((path) => !directoryEntries.has(path));
  for (const entry of manifest.packages) {
    const prefix = `node_modules/${entry.name}`;
    const packageJsonPath = `${prefix}/package.json`;
    if (!packagedEntries.has(packageJsonPath)) throw new Error(`Bundled Prime Agent runtime is missing ${packageJsonPath}.`);
    const installed = JSON.parse(extractPackageFile(asarPath, packageJsonPath).toString("utf8"));
    if (installed.name !== entry.name || installed.version !== entry.version) {
      throw new Error(`Bundled Prime Agent package mismatch for ${entry.name}.`);
    }
    const archivePath = join(vendorDirectory, entry.file);
    if (sha256(await readFile(archivePath)) !== entry.sha256) {
      throw new Error(`Vendored Prime Agent archive hash mismatch for ${entry.name}.`);
    }
    const archive = await digestPrimeArchive(archivePath);
    if (archive.treeDigest !== entry.treeSha256) {
      throw new Error(`Vendored Prime Agent archive tree mismatch for ${entry.name}.`);
    }
    if (runtimePackageMetadataDigest(installed) !== archive.metadataDigest) {
      throw new Error(`Bundled Prime Agent package metadata mismatch for ${entry.name}.`);
    }
    const subtreeEntries = packagedFileEntries
      .filter((path) => path.startsWith(`${prefix}/`))
      .map((path) => ({ absolutePath: path, path: path.slice(prefix.length + 1) }))
      .filter(({ path }) => primeRuntimeSourcePathIsPackaged(path))
      .map(({ absolutePath, path }) => ({ path, bytes: extractPackageFile(asarPath, absolutePath) }));
    if (digestFileEntries(subtreeEntries) !== entry.treeSha256) {
      throw new Error(`Bundled Prime Agent package bytes mismatch for ${entry.name}.`);
    }
  }
  const closureArguments = [
    asarPath,
    manifest.packages.map((entry) => `node_modules/${entry.name}`),
    packagedFileEntries,
    packagedEntries,
    extractPackageFile,
  ];
  if (integrityPhase === "unsigned") {
    const dependencyClosureDigest = verifyDependencyClosure(...closureArguments);
    const expectedClosureDigest = manifest.dependencyClosureSha256ByTarget[targetKey];
    if (!expectedClosureDigest || dependencyClosureDigest !== expectedClosureDigest) {
      throw new Error(
        `Bundled Prime Agent dependency closure mismatch for ${targetKey}: expected ${expectedClosureDigest || "missing"}, actual ${dependencyClosureDigest}.`,
      );
    }
  } else {
    verifySignedDependencyClosureSnapshot(
      collectDependencyClosure(...closureArguments),
      await readSignedClosureSnapshot(),
      targetKey,
    );
  }
  const requiredEntries = [
    "node_modules/@earendil-works/pi-coding-agent/dist/index.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/core/run-model-scope.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/core/run-tool-authority.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/core/run-kernel-boundary.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/skills/browser/SKILL.md",
    "node_modules/@earendil-works/pi-coding-agent/dist/skills/browser/pyproject.toml",
    "node_modules/@earendil-works/pi-coding-agent/dist/skills/browser/src/browser/__init__.py",
    "node_modules/@earendil-works/pi-coding-agent/skills/agent-message/SKILL.md",
    "node_modules/@earendil-works/pi-coding-agent/skills/browser/SKILL.md",
    "node_modules/@earendil-works/pi-coding-agent/skills/browser/pyproject.toml",
    "node_modules/@earendil-works/pi-coding-agent/skills/browser/src/browser/__init__.py",
    "node_modules/@earendil-works/pi-ai/dist/providers/anthropic.js",
    "node_modules/@earendil-works/pi-ai/dist/providers/openai-completions.js",
    "node_modules/@earendil-works/pi-ai/dist/providers/openai-responses.js",
    ...PACKAGED_PROVIDER_MODULES.map((modulePath) => `main/${modulePath}`),
  ];
  for (const entry of requiredEntries) {
    if (!packagedEntries.has(entry)) throw new Error(`Bundled Prime Agent runtime is missing ${entry}.`);
  }
  const forbidden = [...packagedEntries].filter((entry) => (
    /^node_modules\/@earendil-works\/.*\/(?:docs|examples|test|tests|__fixtures__|__tests__)\//.test(entry)
      || /^node_modules\/@earendil-works\/.*\/(?:README|CHANGELOG)\.md$/.test(entry)
      || /^node_modules\/@earendil-works\/.*\.(?:d\.ts|map)$/.test(entry)
      || entry.endsWith("/postinstall.cjs")
      || entry.startsWith("node_modules/@earendil-works/pi-ai/dist/providers/faux.")
  ));
  if (forbidden.length > 0) throw new Error(`Bundled Prime Agent contains development artifacts: ${forbidden[0]}.`);
  return { sourceCommit: manifest.source.commit, packages: manifest.packages.length };
}

export function collectAsarDependencyClosureEntries(asarPath, rootInstallPaths, fileEntries, allEntries, extractPackageFile) {
  const queue = [...rootInstallPaths];
  const visited = new Set();
  const digestEntries = [];
  while (queue.length > 0) {
    const installPath = queue.shift();
    if (visited.has(installPath)) continue;
    visited.add(installPath);
    const packageJsonPath = `${installPath}/package.json`;
    if (!allEntries.has(packageJsonPath)) throw new Error(`Bundled Prime dependency is missing ${packageJsonPath}.`);
    const metadata = JSON.parse(extractPackageFile(asarPath, packageJsonPath).toString("utf8"));
    for (const { name: dependencyName, required } of runtimeDependencyRequirements(metadata)) {
      const resolved = dependencyInstallCandidates(installPath, dependencyName)
        .find((candidate) => allEntries.has(`${candidate}/package.json`));
      if (!resolved && required) {
        throw new Error(`Bundled Prime dependency ${dependencyName} is unresolved from ${installPath}.`);
      }
      if (!resolved) continue;
      queue.push(resolved);
    }
    for (const absolutePath of fileEntries.filter((path) => path.startsWith(`${installPath}/`))) {
      const path = absolutePath.slice(installPath.length + 1);
      if (!runtimeDependencyFileIsPackaged(path)) continue;
      digestEntries.push({ path: absolutePath, bytes: extractPackageFile(asarPath, absolutePath) });
    }
  }
  return digestEntries;
}

export function digestAsarDependencyClosure(asarPath, rootInstallPaths, fileEntries, allEntries, extractPackageFile) {
  return digestFileEntries(collectAsarDependencyClosureEntries(
    asarPath,
    rootInstallPaths,
    fileEntries,
    allEntries,
    extractPackageFile,
  ));
}

export async function writePrimeAgentSigningClosureSnapshot(resourcesPath, targetKey) {
  const asarPath = join(resourcesPath, "app.asar");
  const packagedEntries = new Set(listPackage(asarPath).map(normalizeAsarEntry));
  const directoryEntries = new Set();
  for (const path of packagedEntries) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directoryEntries.add(segments.slice(0, index).join("/"));
    }
  }
  const packagedFileEntries = [...packagedEntries].filter((path) => !directoryEntries.has(path));
  const manifest = JSON.parse(await readFile(join(resourcesPath, "prime-agent", "manifest.json"), "utf8"));
  const entries = collectAsarDependencyClosureEntries(
    asarPath,
    manifest.packages.map((entry) => `node_modules/${entry.name}`),
    packagedFileEntries,
    packagedEntries,
    (archivePath, entry) => extractFile(archivePath, asarEntryPath(entry)),
  );
  const snapshot = createSignedDependencyClosureSnapshot(entries, targetKey);
  await writeFile(
    join(resourcesPath, "prime-agent", "signing-closure.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
  return snapshot;
}

async function digestPrimeArchive(path) {
  const entries = [];
  let metadataDigest;
  await tar.t({
    file: path,
    onentry(entry) {
      if (entry.type !== "File") {
        entry.resume();
        return;
      }
      const archivePath = entry.path.replace(/^package\//, "");
      if (archivePath === "package.json") {
        const chunks = [];
        entry.on("data", (chunk) => chunks.push(chunk));
        entry.on("end", () => {
          const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          metadataDigest = runtimePackageMetadataDigest(metadata);
        });
        return;
      }
      if (!primeRuntimeSourcePathIsPackaged(archivePath)) {
        entry.resume();
        return;
      }
      const chunks = [];
      entry.on("data", (chunk) => chunks.push(chunk));
      entry.on("end", () => entries.push({ path: archivePath, bytes: Buffer.concat(chunks) }));
    },
  });
  if (!metadataDigest) throw new Error(`Vendored Prime Agent archive is missing package.json: ${path}`);
  return { treeDigest: digestFileEntries(entries), metadataDigest };
}

// Signed CI builds packaged the bundle with a restrictive umask, shipping a
// 0700 application. Spotlight and Launch Services cannot traverse a bundle they
// cannot read, so the installed app never appeared in search, and no other
// account on the machine could launch it. Local builds were already 0755, so
// this only ever reproduced from a release DMG.
//
// Widen group and other to match the owner the way `chmod -R go+rX` does: read
// everywhere the owner can read, traverse or execute only for directories and
// files that are already executable.
export async function normalizePackagedBundlePermissions(bundlePath) {
  const changed = [];
  const entries = await readdir(bundlePath, { withFileTypes: true, recursive: true });
  for (const entry of [{ parentPath: bundlePath, name: "", isDirectory: () => true }, ...entries]) {
    const path = entry.name ? join(entry.parentPath, entry.name) : bundlePath;
    const info = await lstat(path);
    // Never follow a symlink: chmod would retarget onto the linked file.
    if (info.isSymbolicLink()) continue;
    const mode = info.mode & 0o7777;
    let next = mode;
    if (mode & 0o400) next |= 0o044;
    if (info.isDirectory() || (mode & 0o100)) next |= 0o011;
    if (next === mode) continue;
    await chmod(path, next);
    changed.push(path);
  }
  return changed;
}

export default async function verifyElectronBuilderBundledAppServer(context) {
  const productFilename = String(context?.packager?.appInfo?.productFilename || "").trim();
  const appOutDir = String(context?.appOutDir || "").trim();
  if (!productFilename || !appOutDir) {
    throw new Error("electron-builder afterPack context is missing the packaged app path.");
  }
  const target = desktopTargetFromEnvironment(process.env);
  const expectedArchitecture = target.architecture === "x64" ? "x86_64" : target.architecture;
  const appPath = target.platform === "darwin" ? join(appOutDir, `${productFilename}.app`) : appOutDir;
  const result = await verifyBundledAppServer(appPath, { platform: target.platform, expectedArchitecture });
  if (target.platform === "darwin") {
    const resourcesPath = join(appPath, "Contents", "Resources");
    await writePrimeAgentSigningClosureSnapshot(resourcesPath, `${target.platform}-${target.architecture}`);
    // Last, so every file this hook wrote is covered, and before
    // electron-builder signs: the signature is then taken over the bundle users
    // actually receive. Windows governs access through ACLs rather than POSIX
    // modes, so normalising there would be work without an effect.
    await normalizePackagedBundlePermissions(appPath);
  }
  return result;
}
