import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

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
  let fixture;
  let bundle;

  beforeAll(() => {
    fixture = join(
      tmpdir(),
      `relayer-lbug-artifact-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const targetDirectory = join(fixture, "target");
    const lbugSource = join(fixture, "lbug-source");
    const buildSource = join(
      targetDirectory,
      "debug",
      "build",
      "lbug-deadbeef",
      "out",
      "build",
      "src",
    );
    const include = join(lbugSource, "lbug-src", "src", "include");
    mkdirSync(buildSource, { recursive: true });
    mkdirSync(join(include, "c_api"), { recursive: true });
    mkdirSync(join(include, "main"), { recursive: true });
    mkdirSync(join(include, "common"), { recursive: true });
    writeFileSync(join(buildSource, "liblbug.a"), "archive-bytes");
    writeFileSync(join(include, "c_api", "lbug.h"), "#pragma once\n");
    writeFileSync(join(include, "main", "lbug.h"), "#pragma once\n");
    writeFileSync(join(include, "common", "types.h"), "#pragma once\n");

    bundle = join(fixture, "bundle");
    run([
      "create",
      "--repository", repositoryRoot,
      "--target-dir", targetDirectory,
      "--artifact-dir", bundle,
      "--lbug-source-dir", lbugSource,
      "--source-commit", sourceCommit,
      ...identity,
    ]);
  });

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  function tamperedCopy(name) {
    const copy = join(fixture, name);
    cpSync(bundle, copy, { recursive: true });
    return copy;
  }

  test("packages the library, the include tree, and a flat umbrella layout", () => {
    const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
    expect(manifest.kind).toBe("lbug-prebuilt");
    expect(manifest.sourceCommit).toBe(sourceCommit);
    expect(manifest.platform).toBe("Linux-X64");
    expect(manifest.rustcRelease).toBe("1.94.0");
    expect(manifest.lbugVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Array.isArray(manifest.lbugFeatures)).toBe(true);
    expect(manifest.library.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof manifest.library.sizeBytes).toBe("number");
    expect(manifest.contentsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(bundle, "lib", "liblbug.a"))).toBe(true);
    expect(existsSync(join(bundle, "include", "lbug.h"))).toBe(true);
    expect(existsSync(join(bundle, "include", "lbug.hpp"))).toBe(true);
    expect(existsSync(join(bundle, "include", "common", "types.h"))).toBe(true);
  });

  test("verify accepts an untampered bundle and exports the link environment", () => {
    const envFile = join(fixture, "github-env-happy");
    run([
      "verify",
      "--repository", repositoryRoot,
      "--artifact-dir", bundle,
      "--github-env", envFile,
      ...identity,
    ]);
    const exported = readFileSync(envFile, "utf8");
    expect(exported).toContain(`LBUG_LIBRARY_DIR=${join(bundle, "lib")}`);
    expect(exported).toContain(`LBUG_INCLUDE_DIR=${join(bundle, "include")}`);
  });

  test("verify rejects a tampered library before any environment is exported", () => {
    const copy = tamperedCopy("tampered-lib");
    appendFileSync(join(copy, "lib", "liblbug.a"), "tampered");
    const envFile = join(fixture, "github-env-tampered-lib");
    expect(() =>
      run([
        "verify",
        "--repository", repositoryRoot,
        "--artifact-dir", copy,
        "--github-env", envFile,
        ...identity,
      ]),
    ).toThrow(/digest does not match/);
    expect(existsSync(envFile)).toBe(false);
  });

  test("verify rejects a bundle built for another platform", () => {
    expect(() =>
      run([
        "verify",
        "--repository", repositoryRoot,
        "--artifact-dir", bundle,
        "--platform", "macOS-ARM64",
        "--rustc-release", "1.94.0",
      ]),
    ).toThrow(/platform/);
  });

  test("verify rejects a bundle built by another toolchain", () => {
    expect(() =>
      run([
        "verify",
        "--repository", repositoryRoot,
        "--artifact-dir", bundle,
        "--platform", "Linux-X64",
        "--rustc-release", "9.9.9",
      ]),
    ).toThrow(/rustc/);
  });

  test("verify rejects a bundle sealed against an older Cargo.lock", () => {
    const copy = tamperedCopy("stale-lock");
    const manifestPath = join(copy, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.cargoLockSha256 = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    expect(() =>
      run([
        "verify",
        "--repository", repositoryRoot,
        "--artifact-dir", copy,
        ...identity,
      ]),
    ).toThrow(/Cargo\.lock digest/);
  });

  test("verify rejects a truncated include tree via the contents digest", () => {
    const copy = tamperedCopy("tampered-include");
    writeFileSync(join(copy, "include", "common", "types.h"), "truncated\n");
    expect(() =>
      run([
        "verify",
        "--repository", repositoryRoot,
        "--artifact-dir", copy,
        ...identity,
      ]),
    ).toThrow(/contents digest/);
  });

  test("verify rejects a library whose size does not match the manifest", () => {
    const copy = tamperedCopy("stale-size");
    const manifestPath = join(copy, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.library.sizeBytes += 1;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    expect(() =>
      run([
        "verify",
        "--repository", repositoryRoot,
        "--artifact-dir", copy,
        ...identity,
      ]),
    ).toThrow(/size does not match/);
  });

  test("verify rejects a directory without a manifest", () => {
    const empty = join(fixture, "empty-bundle");
    mkdirSync(empty, { recursive: true });
    expect(() =>
      run([
        "verify",
        "--repository", repositoryRoot,
        "--artifact-dir", empty,
        ...identity,
      ]),
    ).toThrow(/manifest\.json missing/);
  });

  test("create fails loudly when the target directory has no Ladybug build", () => {
    expect(() =>
      run([
        "create",
        "--repository", repositoryRoot,
        "--target-dir", join(fixture, "empty-target"),
        "--artifact-dir", join(fixture, "bundle-missing"),
        "--lbug-source-dir", join(fixture, "lbug-source"),
        "--source-commit", sourceCommit,
        ...identity,
      ]),
    ).toThrow(/no build outputs|no lbug CMake output/);
  });
});
