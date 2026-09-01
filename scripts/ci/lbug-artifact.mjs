#!/usr/bin/env node

// Packages (or verifies) a prebuilt liblbug produced from the pinned bundled
// Ladybug source, so Rust lanes can link it instead of rerunning the CMake
// build in every lane. The bundle is acceleration, never verification: every
// test still compiles and runs freshly against whatever library it links.
//
// Identity model: the library is fully determined by the pinned crate source
// (Cargo.lock checksums), the toolchain, and the platform. The commit that
// produced a bundle is recorded for provenance but is not part of equality,
// because the bundled source cannot change without a Cargo.lock change.

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
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRepository = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

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

function lbugPackageMetadata(repository) {
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      ["metadata", "--locked", "--format-version", "1"],
      // The full dependency graph is large; the default 1 MB buffer overflows.
      { cwd: repository, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
    ),
  );
  const lbug = metadata.packages.find((candidate) => candidate.name === "lbug");
  if (!lbug) throw new Error("Cargo.lock does not contain the lbug crate");
  return lbug;
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
  if (result.status !== 0) {
    console.warn(
      `warning: could not strip debug info from ${basename(libraryPath)}: ${(result.stderr || "").toString().trim()}`,
    );
  }
}

export function createLbugArtifact({
  repository,
  targetDirectory,
  artifactDirectory,
  sourceCommit,
  platform,
  rustcRelease,
  lbugSourceDirectory,
}) {
  assertIdentityInputs({ platform, rustcRelease });
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? "")) {
    throw new Error("source commit must be a lowercase 40-character SHA");
  }
  const outDirectory = findBuildOutput(targetDirectory);
  const librarySource = join(outDirectory, "build", "src", "liblbug.a");

  const lbugSource =
    lbugSourceDirectory ??
    dirname(lbugPackageMetadata(repository).manifest_path);
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
  stripDebugInfo(libraryDestination);
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
    lbugVersion: lbugPackageMetadata(repository).version,
    cargoProfile: "debug",
    library: { name: "liblbug.a", sha256: sha256(libraryDestination) },
  };
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
  const manifest = JSON.parse(
    readFileSync(join(artifactDirectory, "manifest.json"), "utf8"),
  );
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
  const lbug = lbugPackageMetadata(repository);
  if (manifest.lbugVersion !== lbug.version) {
    problems.push(`lbug ${manifest.lbugVersion} does not match pinned ${lbug.version}`);
  }
  const libraryPath = join(artifactDirectory, "lib", manifest.library?.name ?? "liblbug.a");
  if (!existsSync(libraryPath)) {
    problems.push("liblbug.a missing from the bundle");
  } else if (sha256(libraryPath) !== manifest.library.sha256) {
    problems.push("liblbug.a digest does not match the manifest");
  }
  for (const header of ["lbug.h", "lbug.hpp"]) {
    if (!existsSync(join(artifactDirectory, "include", header))) {
      problems.push(`include/${header} missing from the bundle`);
    }
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
    });
    process.stdout.write(
      `Prebuilt Ladybug bundle created for lbug ${manifest.lbugVersion} (${manifest.library.sha256.slice(0, 12)}).\n`,
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
