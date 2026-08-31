import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import { basename, dirname, join } from "node:path";

const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
export const MAX_LIVE_RUN_TIMEOUT_MS = 60 * 60 * 1_000;
export const CHECK1_VERIFICATION_LEVEL = "check1";
export const CHECK1_STATUS = Object.freeze({
  running: "check1-running",
  passed: "check1-passed",
  failed: "check1-failed",
});

/** Binds provider selection without retaining authentication or machine-local paths. */
export function publicProfileDigest(profile) {
  return sha256(JSON.stringify({
    name: profile.name,
    harness: profile.harness,
    implementation: profile.implementation,
    providerId: profile.providerId,
    adapterId: profile.adapterId,
    contract: profile.contract,
    modelId: profile.modelId,
    endpoint: normalizedEndpoint(profile.endpoint),
  }));
}

function normalizedEndpoint(value) {
  if (value === undefined) return null;
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Live-run provider endpoint must be a valid URL");
  }
  if (!["http:", "https:"].includes(endpoint.protocol)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash) {
    throw new Error("Live-run provider endpoint must be an HTTP URL without credentials, query, or fragment");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, "") || "/";
  return endpoint.toString();
}

/** Validates the paid-arm deadline before any provider execution can be acquired. */
export function liveRunTimeoutMs(value) {
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_LIVE_RUN_TIMEOUT_MS) {
    throw new Error(`--timeout-ms must be a positive integer no greater than ${MAX_LIVE_RUN_TIMEOUT_MS}`);
  }
  return timeout;
}

function git(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** A stable digest of every tracked diff and every untracked file without exposing paths. */
export function workspaceProvenance(repositoryRoot) {
  const head = String(git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
  const status = git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const trackedDiff = git(repositoryRoot, ["diff", "--binary", "HEAD", "--"]);
  const untrackedPaths = git(repositoryRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256").update(status).update(trackedDiff);
  for (const path of untrackedPaths) {
    const absolutePath = join(repositoryRoot, path);
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      hash.update(path).update("\0symlink\0").update(readlinkSync(absolutePath));
    } else if (stat.isFile()) {
      hash.update(path).update("\0file\0").update(readFileSync(absolutePath));
    } else {
      throw new Error(`Workspace provenance cannot digest non-file untracked path ${path}`);
    }
  }
  return {
    commit: head,
    clean: status.length === 0,
    workspaceDigest: `sha256:${hash.digest("hex")}`,
  };
}

/** Describes executable bytes; a version is supplementary and never substitutes for them. */
export function executableProvenance(path, version) {
  const bytes = readFileSync(path);
  return {
    sha256: sha256(bytes),
    bytes: bytes.byteLength,
    ...(version ? { version } : {}),
  };
}

/** Stable identity for every regular file and symlink below one generated bundle root. */
export function directoryProvenance(root) {
  const entries = [];
  const visit = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path, relativePath);
      } else if (stat.isSymbolicLink()) {
        entries.push({ path: relativePath, kind: "symlink", bytes: Buffer.from(readlinkSync(path)) });
      } else if (stat.isFile()) {
        entries.push({ path: relativePath, kind: "file", bytes: readFileSync(path) });
      } else {
        throw new Error(`Runtime bundle contains unsupported entry ${relativePath}`);
      }
    }
  };
  visit(root);
  const hash = createHash("sha256");
  let bytes = 0;
  for (const entry of entries) {
    hash.update(entry.path).update("\0").update(entry.kind).update("\0").update(entry.bytes).update("\0");
    bytes += entry.bytes.byteLength;
  }
  return { sha256: `sha256:${hash.digest("hex")}`, files: entries.length, bytes };
}

/** Captures every source, native executable, Node runtime, and generated JS input one arm executes. */
export function executionIdentity({ repositoryRoot, executables, bundles }) {
  return {
    source: workspaceProvenance(repositoryRoot),
    executables: Object.fromEntries(Object.entries(executables).map(([name, executable]) => [
      name,
      executableProvenance(executable.path, executable.version),
    ])),
    bundles: Object.fromEntries(Object.entries(bundles).map(([name, path]) => [
      name,
      directoryProvenance(path),
    ])),
  };
}

/** Fails closed when either arm would execute bytes different from the immutable header. */
export function assertExecutionIdentity(expected, observed, checkpoint) {
  if (JSON.stringify(expected) !== JSON.stringify(observed)) {
    throw new Error(`Live-run execution identity changed at ${checkpoint}`);
  }
}

/** Writes one complete JSON value durably without exposing a torn canonical receipt. */
export function writeJsonAtomic(path, value) {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
    let directoryDescriptor;
    try {
      directoryDescriptor = openSync(dirname(path), "r");
      fsyncSync(directoryDescriptor);
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EBADF"].includes(error?.code)) throw error;
    } finally {
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/** Creates the immutable header shared by both halves of one paid comparison. */
export function liveRunProvenance({
  harnessConfigurationDigest,
  temporalFeatureSchemaVersion,
  identity,
  now = new Date(),
  runId = randomUUID(),
}) {
  return {
    schemaVersion: 1,
    runId,
    createdAt: now.toISOString(),
    ...identity,
    environment: {
      platform: platform(),
      architecture: arch(),
      release: release(),
      node: process.version,
    },
    harnessConfigurationDigest,
    temporalFeatureSchemaVersion,
  };
}
