#!/usr/bin/env node

// Packages (or verifies) a prebuilt liblbug produced from the pinned bundled
// Ladybug source, so Rust lanes can link it instead of rerunning the CMake
// build in every lane. The bundle is acceleration, never verification: every
// test still compiles and runs freshly against whatever library it links.
//
// Identity model: the library is fully determined by the pinned crate source
// (Cargo.lock checksums), the resolved lbug feature set, the toolchain, and
// the platform. The commit that produced a bundle is recorded for provenance
// but is not part of equality, because the bundled source cannot change
// without a Cargo.lock change. The manifest also carries a digest over every
// packaged file, so a truncated include tree is rejected before any lane
// links against it.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepository = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
// A stripped debug archive measures ~440 MB; an unstripped one ~1.8 GB. An
// oversize library means stripping failed, which would balloon every lane
// download and the trusted cache entry.
const LIBRARY_SIZE_CEILING_BYTES = 800 * 1024 * 1024;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      options.command = argument;
      continue;
    }
    const name = argument.slice(2);
    options[name] = argv[index + 1];
    index += 1;
  }
  return options;
}

function assertIdentityInputs({ platform, rustcRelease }) {
  if (!platform) throw new Error("platform is required");
  if (!rustcRelease) throw new Error("rustc release is required");
}

function cargoLockSha256(repository) {
  return sha256(join(repository, "Cargo.lock"));
}

// Resolves the full dependency graph once; callers reuse the result.
function cargoMetadata(repository) {
  return JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--locked", "--format-version", "1"],
      // The full dependency graph is large; the default 1 MB buffer overflows.
      { cwd: repository, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
    ),
  );
}

function lbugPackageMetadata(metadata) {
  const lbug = metadata.packages.find((candidate) => candidate.name === "lbug");
  if (!lbug) throw new Error("Cargo.lock does not contain the lbug crate");
  return lbug;
}

// The features Cargo resolved for lbug. An optional lbug feature enabled by a
// workspace crate later would change the build; recording the resolution lets
// verify reject a bundle built without it and fall back to the source build.
function lbugResolvedFeatures(metadata) {
  const node = (metadata.resolve?.nodes ?? []).find((candidate) =>
    /#lbug@/.test(candidate.id),
  );
  if (!node) throw new Error("Cargo resolve graph does not contain lbug");
  return [...(node.features ?? [])].sort();
}

function findBuildOutput(targetDirectory) {
  const buildRoot = join(targetDirectory, "debug", "build");
  if (!existsSync(buildRoot)) {
    throw new Error(`no build outputs under ${buildRoot}; run cargo build -p lbug first`);
  }
  for (const entry of readdirSync(buildRoot)) {
    if (!entry.startsWith("lbug-")) continue;
    const library = join(buildRoot, entry, "out", "build", "src", "liblbug.a");
    if (existsSync(library)) return join(buildRoot, entry, "out");
  }
  throw new Error("no lbug CMake output (liblbug.a) found in the target directory");
}

function stripDebugInfo(libraryPath) {
  const result = spawnSync("strip", ["-S", libraryPath], { stdio: "pipe" });
  return result.status === 0;
}

function walkFiles(rootDirectory) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  walk(rootDirectory);
  return files
    .map((path) => relative(rootDirectory, path).split("\\").join("/"))
    .sort();
}

// Digest over every packaged file (paths + contents), excluding the manifest.
function bundleContentsSha256(artifactDirectory) {
  const hash = createHash("sha256");
  for (const relativePath of walkFiles(artifactDirectory)) {
    if (relativePath === "manifest.json") continue;
    hash.update(relativePath);
    hash.update("\0");
    hash.update(readFileSync(join(artifactDirectory, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function createLbugArtifact({
  repository,
  targetDirectory,
  artifactDirectory,
  sourceCommit,
  platform,
  rustcRelease,
  lbugSourceDirectory,
  lbugVersionOverride,
  lbugFeaturesOverride,
}) {
  assertIdentityInputs({ platform, rustcRelease });
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? "")) {
    throw new Error("source commit must be a lowercase 40-character SHA");
  }
  const outDirectory = findBuildOutput(targetDirectory);
  const librarySource = join(outDirectory, "build", "src", "liblbug.a");

  // Resolve the dependency graph once and reuse it for the version, the
  // resolved feature set, and (unless overridden) the crate source location.
  // Test callers override all three and skip the cargo spawn entirely.
  const fullyOverridden =
    lbugSourceDirectory && lbugVersionOverride && lbugFeaturesOverride;
  const metadata = fullyOverridden ? null : cargoMetadata(repository);
  const lbugVersion = lbugVersionOverride ?? lbugPackageMetadata(metadata).version;
  const lbugFeatures = lbugFeaturesOverride ?? lbugResolvedFeatures(metadata);
  const lbugSource =
    lbugSourceDirectory ?? dirname(lbugPackageMetadata(metadata).manifest_path);
  const includeSource = join(lbugSource, "lbug-src", "src", "include");
  for (const required of [
    join(includeSource, "c_api", "lbug.h"),
    join(includeSource, "main", "lbug.h"),
  ]) {
    if (!existsSync(required)) {
      throw new Error(`expected Ladybug header missing: ${required}`);
    }
  }

  const libDirectory = join(artifactDirectory, "lib");
  const includeDirectory = join(artifactDirectory, "include");
  mkdirSync(libDirectory, { recursive: true });
  mkdirSync(includeDirectory, { recursive: true });

  const libraryDestination = join(libDirectory, "liblbug.a");
  copyFileSync(librarySource, libraryDestination);
  const stripped = stripDebugInfo(libraryDestination);
  if (!stripped) {
    console.warn(
      "warning: could not strip debug info from liblbug.a; the bundle is larger than expected",
    );
  }
  cpSync(includeSource, includeDirectory, { recursive: true });
  // The external-link path compiles the FFI unit without LBUG_BUNDLED, which
  // includes bare <lbug.h> and <lbug.hpp>; provide the flat umbrellas the
  // upstream install layout uses.
  copyFileSync(join(includeSource, "c_api", "lbug.h"), join(includeDirectory, "lbug.h"));
  copyFileSync(join(includeSource, "main", "lbug.h"), join(includeDirectory, "lbug.hpp"));

  const manifest = {
    version: 1,
    kind: "lbug-prebuilt",
    sourceCommit,
    platform,
    rustcRelease,
    cargoLockSha256: cargoLockSha256(repository),
    lbugVersion,
    lbugFeatures,
    cargoProfile: "debug",
    library: {
      name: "liblbug.a",
      sha256: sha256(libraryDestination),
      sizeBytes: statSync(libraryDestination).size,
      stripped,
    },
  };
  manifest.contentsSha256 = bundleContentsSha256(artifactDirectory);
  writeFileSync(
    join(artifactDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export function verifyLbugArtifact({
  repository,
  artifactDirectory,
  platform,
  rustcRelease,
  githubEnvFile,
}) {
  assertIdentityInputs({ platform, rustcRelease });
  let manifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(artifactDirectory, "manifest.json"), "utf8"),
    );
  } catch {
    throw new Error("prebuilt Ladybug bundle rejected: manifest.json missing or unreadable");
  }
  const problems = [];
  if (manifest.version !== 1 || manifest.kind !== "lbug-prebuilt") {
    problems.push("manifest is not a v1 lbug-prebuilt bundle");
  }
  if (manifest.platform !== platform) {
    problems.push(`platform ${manifest.platform} does not match ${platform}`);
  }
  if (manifest.rustcRelease !== rustcRelease) {
    problems.push(`rustc ${manifest.rustcRelease} does not match ${rustcRelease}`);
  }
  const expectedLock = cargoLockSha256(repository);
  if (manifest.cargoLockSha256 !== expectedLock) {
    problems.push("Cargo.lock digest does not match the current checkout");
  }
  const metadata = cargoMetadata(repository);
  const lbug = lbugPackageMetadata(metadata);
  if (manifest.lbugVersion !== lbug.version) {
    problems.push(`lbug ${manifest.lbugVersion} does not match pinned ${lbug.version}`);
  }
  const expectedFeatures = lbugResolvedFeatures(metadata);
  if (JSON.stringify(manifest.lbugFeatures ?? null) !== JSON.stringify(expectedFeatures)) {
    problems.push(
      `resolved lbug features ${(manifest.lbugFeatures ?? []).join(",") || "none"} do not match ${expectedFeatures.join(",") || "none"}`,
    );
  }
  const libraryName = manifest.library?.name ?? "liblbug.a";
  const libraryPath = join(artifactDirectory, "lib", libraryName);
  if (!existsSync(libraryPath)) {
    problems.push(`${libraryName} missing from the bundle`);
  } else {
    if (sha256(libraryPath) !== manifest.library?.sha256) {
      problems.push(`${libraryName} digest does not match the manifest`);
    }
    const sizeBytes = statSync(libraryPath).size;
    if (typeof manifest.library?.sizeBytes === "number" && sizeBytes !== manifest.library.sizeBytes) {
      problems.push(`${libraryName} size does not match the manifest`);
    }
    if (sizeBytes > LIBRARY_SIZE_CEILING_BYTES) {
      problems.push(
        `${libraryName} is ${(sizeBytes / (1024 * 1024)).toFixed(0)} MB, above the ${LIBRARY_SIZE_CEILING_BYTES / (1024 * 1024)} MB ceiling; debug stripping likely failed`,
      );
    }
  }
  for (const header of ["lbug.h", "lbug.hpp"]) {
    if (!existsSync(join(artifactDirectory, "include", header))) {
      problems.push(`include/${header} missing from the bundle`);
    }
  }
  if (typeof manifest.contentsSha256 === "string") {
    const actual = bundleContentsSha256(artifactDirectory);
    if (actual !== manifest.contentsSha256) {
      problems.push("bundle contents digest does not match the manifest");
    }
  } else {
    problems.push("manifest is missing the bundle contents digest");
  }
  if (problems.length > 0) {
    throw new Error(`prebuilt Ladybug bundle rejected: ${problems.join("; ")}`);
  }
  if (githubEnvFile) {
    appendFileSync(
      githubEnvFile,
      `LBUG_LIBRARY_DIR=${join(artifactDirectory, "lib")}\nLBUG_INCLUDE_DIR=${join(artifactDirectory, "include")}\n`,
    );
  }
  return manifest;
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const repository = resolve(options.repository ?? defaultRepository);
  if (options.command === "create") {
    const manifest = createLbugArtifact({
      repository,
      targetDirectory: resolve(options["target-dir"]),
      artifactDirectory: resolve(options["artifact-dir"]),
      sourceCommit: options["source-commit"],
      platform: options.platform,
      rustcRelease: options["rustc-release"],
      lbugSourceDirectory: options["lbug-source-dir"]
        ? resolve(options["lbug-source-dir"])
        : undefined,
      lbugVersionOverride: options["lbug-version"],
      lbugFeaturesOverride: options["lbug-features"]
        ? options["lbug-features"].split(",").filter(Boolean).sort()
        : undefined,
    });
    process.stdout.write(
      `Prebuilt Ladybug bundle created for lbug ${manifest.lbugVersion} (${manifest.library.sha256.slice(0, 12)}, ${(manifest.library.sizeBytes / (1024 * 1024)).toFixed(0)} MB${manifest.library.stripped ? ", stripped" : ", UNSTRIPPED"}).\n`,
    );
    return;
  }
  if (options.command === "verify") {
    const manifest = verifyLbugArtifact({
      repository,
      artifactDirectory: resolve(options["artifact-dir"]),
      platform: options.platform,
      rustcRelease: options["rustc-release"],
      githubEnvFile: options["github-env"],
    });
    process.stdout.write(
      `Prebuilt Ladybug bundle verified for lbug ${manifest.lbugVersion} (built at ${manifest.sourceCommit}).\n`,
    );
    return;
  }
  throw new Error("Usage: lbug-artifact.mjs create|verify ...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
