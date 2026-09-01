import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, afterEach, describe, expect, test } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const script = join(repositoryRoot, "scripts", "ci", "lbug-artifact.mjs");
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const identity = ["--platform", "Linux-X64", "--rustc-release", "1.94.0"];

function run(args, cwd = repositoryRoot) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("prebuilt Ladybug artifact", () => {
  let directory;
  let targetDirectory;
  let lbugSource;

  beforeEach(() => {
    directory = join(tmpdir(), `relayer-lbug-artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    targetDirectory = join(directory, "target");
    lbugSource = join(directory, "lbug-source");
    const buildSource = join(targetDirectory, "debug", "build", "lbug-deadbeef", "out", "build", "src");
    const include = join(lbugSource, "lbug-src", "src", "include");
    mkdirSync(buildSource, { recursive: true });
    mkdirSync(join(include, "c_api"), { recursive: true });
    mkdirSync(join(include, "main"), { recursive: true });
    mkdirSync(join(include, "common"), { recursive: true });
    writeFileSync(join(buildSource, "liblbug.a"), "archive-bytes");
    writeFileSync(join(include, "c_api", "lbug.h"), "#pragma once\n");
    writeFileSync(join(include, "main", "lbug.h"), "#pragma once\n");
    writeFileSync(join(include, "common", "types.h"), "#pragma once\n");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function create() {
    const artifactDirectory = join(directory, "bundle");
    run([
      "create",
      "--repository", repositoryRoot,
      "--target-dir", targetDirectory,
      "--artifact-dir", artifactDirectory,
      "--lbug-source-dir", lbugSource,
      "--source-commit", sourceCommit,
      ...identity,
    ]);
    return artifactDirectory;
  }

  test("packages the library, the include tree, and a flat umbrella layout", () => {
    const artifactDirectory = create();
    const manifest = JSON.parse(readFileSync(join(artifactDirectory, "manifest.json"), "utf8"));
    expect(manifest.kind).toBe("lbug-prebuilt");
    expect(manifest.sourceCommit).toBe(sourceCommit);
    expect(manifest.platform).toBe("Linux-X64");
    expect(manifest.rustcRelease).toBe("1.94.0");
    expect(manifest.lbugVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.library.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(artifactDirectory, "lib", "liblbug.a"))).toBe(true);
    expect(existsSync(join(artifactDirectory, "include", "lbug.h"))).toBe(true);
    expect(existsSync(join(artifactDirectory, "include", "lbug.hpp"))).toBe(true);
    expect(existsSync(join(artifactDirectory, "include", "common", "types.h"))).toBe(true);
  });

  test("verify accepts an untampered bundle and exports the link environment", () => {
    const artifactDirectory = create();
    const envFile = join(directory, "github-env");
    run([
      "verify",
      "--repository", repositoryRoot,
      "--artifact-dir", artifactDirectory,
      "--github-env", envFile,
      ...identity,
    ]);
    const exported = readFileSync(envFile, "utf8");
    expect(exported).toContain(`LBUG_LIBRARY_DIR=${join(artifactDirectory, "lib")}`);
    expect(exported).toContain(`LBUG_INCLUDE_DIR=${join(artifactDirectory, "include")}`);
  });

  test("verify rejects a tampered library before any environment is exported", () => {
    const artifactDirectory = create();
    appendFileSync(join(artifactDirectory, "lib", "liblbug.a"), "tampered");
    const envFile = join(directory, "github-env");
    expect(() =>
      run([
        "verify",
        "--repository", repositoryRoot,
        "--artifact-dir", artifactDirectory,
        "--github-env", envFile,
        ...identity,
      ]),
    ).toThrow(/digest does not match/);
    expect(existsSync(envFile)).toBe(false);
  });

  test("verify rejects a bundle built for another platform", () => {
    const artifactDirectory = create();
    expect(() =>
      run([
        "verify",
        "--repository", repositoryRoot,
        "--artifact-dir", artifactDirectory,
        "--platform", "macOS-ARM64",
        "--rustc-release", "1.94.0",
      ]),
    ).toThrow(/platform/);
  });

  test("create fails loudly when the target directory has no Ladybug build", () => {
    expect(() =>
      run([
        "create",
        "--repository", repositoryRoot,
        "--target-dir", join(directory, "empty-target"),
        "--artifact-dir", join(directory, "bundle-missing"),
        "--lbug-source-dir", lbugSource,
        "--source-commit", sourceCommit,
        ...identity,
      ]),
    ).toThrow(/no build outputs|no lbug CMake output/);
  });
});
