#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepository = resolve(scriptDirectory, "..", "..");

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertProvenance(sourceCommit) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? ""))
    throw new Error("source commit must be a lowercase 40-character SHA");
}

function assertIdentity({ rustInputDigest, platform, rustcRelease }) {
  if (!/^[0-9a-f]{64}$/.test(rustInputDigest ?? ""))
    throw new Error(
      "Rust input digest must be a lowercase 64-character SHA-256",
    );
  if (!platform) throw new Error("platform is required");
  if (!rustcRelease) throw new Error("rustc release is required");
}

export function createRuntimeArtifact({
  repository,
  targetDirectory,
  artifactDirectory,
  sourceCommit,
  rustInputDigest,
  platform,
  rustcRelease,
  cargoProfile = "debug",
  packages,
}) {
  assertProvenance(sourceCommit);
  assertIdentity({ rustInputDigest, platform, rustcRelease });
  const selectedPackages = [...new Set(packages)].sort();
  if (selectedPackages.length === 0)
    throw new Error("at least one runtime package is required");
  for (const packageName of selectedPackages) {
    if (basename(packageName) !== packageName)
      throw new Error(`${packageName}: invalid runtime package name`);
  }

  const binaryDirectory = join(artifactDirectory, "bin");
  mkdirSync(binaryDirectory, { recursive: true });
  const binaries = selectedPackages.map((packageName) => {
    const source = join(targetDirectory, packageName);
    const destination = join(binaryDirectory, packageName);
    copyFileSync(source, destination);
    return { name: packageName, sha256: sha256(destination) };
  });
  const manifest = {
    version: 1,
    // The digest over crates/, Cargo.toml, Cargo.lock, and .cargo/ is the
    // identity binding: the binaries are fully determined by those inputs,
    // the toolchain, the platform, and the profile. The commit that produced
    // the artifact is recorded for provenance only, mirroring the Ladybug
    // bundle.
    rustInputDigest,
    sourceCommit,
    platform,
    rustcRelease,
    cargoLockSha256: sha256(join(repository, "Cargo.lock")),
    cargoProfile,
    featureSet: "default",
    binaries,
  };
  writeFileSync(
    join(artifactDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export function verifyRuntimeArtifact({
  repository,
  artifactDirectory,
  installDirectory,
  rustInputDigest,
  platform,
  rustcRelease,
  cargoProfile = "debug",
  expectedPackages,
}) {
  assertIdentity({ rustInputDigest, platform, rustcRelease });
  const manifest = JSON.parse(
    readFileSync(join(artifactDirectory, "manifest.json"), "utf8"),
  );
  const expectedIdentity = {
    version: 1,
    rustInputDigest,
    platform,
    rustcRelease,
    cargoLockSha256: sha256(join(repository, "Cargo.lock")),
    cargoProfile,
    featureSet: "default",
  };
  for (const [field, expected] of Object.entries(expectedIdentity)) {
    if (manifest[field] !== expected)
      throw new Error(`${field}: artifact identity mismatch`);
  }
  if (!Array.isArray(manifest.binaries) || manifest.binaries.length === 0) {
    throw new Error("artifact contains no binaries");
  }
  // Coverage, not equality: a bundle sealing extra binaries is harmless, but
  // one missing a binary the consuming plan requires would leave the Vitest
  // chapters without it. The cache key binds the package set too; this check
  // is the second lock against an under-covering bundle.
  if (Array.isArray(expectedPackages) && expectedPackages.length > 0) {
    const provided = new Set(manifest.binaries.map((binary) => binary.name));
    const missing = expectedPackages.filter(
      (packageName) => !provided.has(packageName),
    );
    if (missing.length > 0) {
      throw new Error(
        `artifact does not cover required runtime packages: ${missing.join(", ")}`,
      );
    }
  }
  for (const binary of manifest.binaries) {
    if (basename(binary.name) !== binary.name)
      throw new Error(`${binary.name}: invalid binary name`);
  }

  const declaredNames = manifest.binaries.map((binary) => binary.name).sort();
  const actualNames = readdirSync(join(artifactDirectory, "bin")).sort();
  if (JSON.stringify(declaredNames) !== JSON.stringify(actualNames)) {
    throw new Error("artifact binary inventory mismatch");
  }
  for (const binary of manifest.binaries) {
    const source = join(artifactDirectory, "bin", binary.name);
    if (sha256(source) !== binary.sha256)
      throw new Error(`${binary.name}: artifact digest mismatch`);
  }
  mkdirSync(installDirectory, { recursive: true });
  for (const binary of manifest.binaries) {
    const source = join(artifactDirectory, "bin", binary.name);
    const destination = join(installDirectory, binary.name);
    copyFileSync(source, destination);
    chmodSync(destination, 0o755);
  }
  return manifest;
}

function parseArguments(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, packages: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const value = rest[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    if (argument === "--package") options.packages.push(value);
    else if (argument === "--repository") options.repository = value;
    else if (argument === "--target-dir") options.targetDirectory = value;
    else if (argument === "--artifact-dir") options.artifactDirectory = value;
    else if (argument === "--install-dir") options.installDirectory = value;
    else if (argument === "--source-commit") options.sourceCommit = value;
    else if (argument === "--rust-input-digest")
      options.rustInputDigest = value;
    else if (argument === "--platform") options.platform = value;
    else if (argument === "--rustc-release") options.rustcRelease = value;
    else if (argument === "--cargo-profile") options.cargoProfile = value;
    else if (argument === "--plan-json") options.planJson = value;
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }
  options.repository = resolve(options.repository ?? defaultRepository);
  options.targetDirectory = resolve(
    options.targetDirectory ?? join(options.repository, "target", "debug"),
  );
  if (options.artifactDirectory)
    options.artifactDirectory = resolve(options.artifactDirectory);
  if (options.installDirectory)
    options.installDirectory = resolve(options.installDirectory);
  if (options.planJson)
    options.packages = JSON.parse(options.planJson).runtimeRustPackages;
  return options;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === "create") createRuntimeArtifact(options);
  else if (options.mode === "verify") {
    if (options.planJson) {
      options.expectedPackages = JSON.parse(options.planJson)
        .runtimeRustPackages;
    }
    verifyRuntimeArtifact(options);
  }
  else
    throw new Error(
      `Unsupported runtime artifact mode: ${options.mode ?? "missing"}`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
