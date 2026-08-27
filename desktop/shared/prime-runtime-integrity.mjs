import { createHash } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function primeRuntimeSourcePathIsPackaged(path) {
  const normalized = String(path).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === "package.json" || normalized.startsWith("node_modules/")) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => ["docs", "examples", "test", "tests", "__fixtures__", "__tests__"].includes(segment))) return false;
  if (/(^|\/)(README|CHANGELOG)\.md$/.test(normalized)) return false;
  if (/\.d\.ts$/.test(normalized) || /\.map$/.test(normalized)) return false;
  if (/(^|\/)postinstall\.cjs$/.test(normalized)) return false;
  if (normalized.startsWith("dist/providers/faux.")) return false;
  if (/\.(fixture|spec|test)\.(cjs|js|mjs)$/.test(normalized)) return false;
  return true;
}

export function runtimeDependencyFileIsPackaged(path) {
  const normalized = String(path).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("node_modules/")) return false;
  const segments = normalized.split("/");
  if (segments.some((segment) => ["docs", "examples", "test", "tests", "__fixtures__", "__tests__"].includes(segment))) return false;
  if (/(^|\/)(README|CHANGELOG)\.md$/.test(normalized)) return false;
  if (/\.d\.ts$/.test(normalized) || /\.map$/.test(normalized)) return false;
  if (/(^|\/)postinstall\.cjs$/.test(normalized)) return false;
  if (/\.(fixture|spec|test)\.(cjs|js|mjs)$/.test(normalized)) return false;
  return true;
}

export function digestFileEntries(entries) {
  const digest = createHash("sha256");
  for (const { path, bytes } of [...entries].sort((left, right) => (
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"))
  ))) {
    digest.update(path).update("\0").update(sha256(bytes)).update("\n");
  }
  return digest.digest("hex");
}

export function runtimePackageMetadata(metadata) {
  const runtimeFields = [
    "name",
    "version",
    "type",
    "main",
    "module",
    "browser",
    "exports",
    "imports",
    "bin",
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "engines",
    "cpu",
    "os",
  ];
  return Object.fromEntries(runtimeFields
    .filter((field) => Object.hasOwn(metadata ?? {}, field))
    .map((field) => [field, normalizeJsonValue(metadata[field])]));
}

export function runtimePackageMetadataDigest(metadata) {
  return sha256(Buffer.from(JSON.stringify(runtimePackageMetadata(metadata)), "utf8"));
}

function normalizeJsonValue(value) {
  if (Array.isArray(value)) return value.map(normalizeJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeJsonValue(value[key])]));
  }
  return value;
}

export async function digestFilesystemTree(root, includePath = () => true) {
  const entries = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if (entry.isFile()) {
        const path = relative(root, absolutePath).replaceAll("\\", "/");
        if (includePath(path)) entries.push({ path, bytes: await readFile(absolutePath) });
      }
    }
  }
  await visit(root);
  return digestFileEntries(entries);
}

export function dependencyInstallCandidates(fromInstallPath, dependencyName) {
  const candidates = [];
  let current = fromInstallPath;
  while (current) {
    candidates.push(`${current}/node_modules/${dependencyName}`);
    const marker = current.lastIndexOf("/node_modules/");
    if (marker < 0) break;
    current = current.slice(0, marker);
  }
  candidates.push(`node_modules/${dependencyName}`);
  return [...new Set(candidates)];
}

export function runtimeDependencyRequirements(metadata) {
  const dependencies = new Map();
  for (const name of Object.keys(metadata.dependencies ?? {})) dependencies.set(name, { name, required: true });
  // npm treats an optionalDependency declaration as overriding dependencies.
  for (const name of Object.keys(metadata.optionalDependencies ?? {})) dependencies.set(name, { name, required: false });
  for (const name of Object.keys(metadata.peerDependencies ?? {})) {
    if (!dependencies.has(name)) {
      dependencies.set(name, {
        name,
        required: metadata.peerDependenciesMeta?.[name]?.optional !== true,
      });
    }
  }
  return [...dependencies.values()].sort((left, right) => (
    Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8"))
  ));
}

export async function digestFilesystemDependencyClosure(appRoot, rootInstallPaths) {
  const queue = [...rootInstallPaths];
  const visited = new Set();
  const entries = [];
  while (queue.length > 0) {
    const installPath = queue.shift();
    if (visited.has(installPath)) continue;
    visited.add(installPath);
    const packageRoot = join(appRoot, ...installPath.split("/"));
    const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    for (const { name: dependencyName, required } of runtimeDependencyRequirements(metadata)) {
      let resolved;
      for (const candidate of dependencyInstallCandidates(installPath, dependencyName)) {
        try {
          await access(join(appRoot, ...candidate.split("/"), "package.json"));
          resolved = candidate;
          break;
        } catch {
          // Continue through Node's ancestor lookup order.
        }
      }
      if (!resolved && required) {
        throw new Error(`Prime runtime dependency ${dependencyName} is unresolved from ${installPath}`);
      }
      if (!resolved) continue;
      queue.push(resolved);
    }
    const packageEntries = [];
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolutePath = join(directory, entry.name);
        const path = relative(packageRoot, absolutePath).replaceAll("\\", "/");
        if (entry.isDirectory()) {
          if (path === "node_modules" || path.startsWith("node_modules/")) continue;
          await visit(absolutePath);
        } else if (entry.isFile() && runtimeDependencyFileIsPackaged(path)) {
          packageEntries.push({ path: `${installPath}/${path}`, bytes: await readFile(absolutePath) });
        }
      }
    }
    await visit(packageRoot);
    entries.push(...packageEntries);
  }
  return digestFileEntries(entries);
}
