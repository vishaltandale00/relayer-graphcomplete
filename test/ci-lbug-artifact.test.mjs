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

  test("packages the library, the include tree, and a flat umbrella layout that verifies and exports the link environment", () => {
    const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));
    expect(manifest.kind, "the bundle identifies itself as the lbug prebuilt").toBe("lbug-prebuilt");
    expect(manifest.sourceCommit, "the bundle is sealed to the source commit").toBe(sourceCommit);
    expect(manifest.platform, "the bundle records its platform").toBe("Linux-X64");
    expect(manifest.rustcRelease, "the bundle records its toolchain").toBe("1.94.0");
    expect(manifest.lbugVersion, "the bundle carries the parsed Ladybug version").toMatch(/^\d+\.\d+\.\d+$/);
    expect(Array.isArray(manifest.lbugFeatures), "the bundle lists its Ladybug features").toBe(true);
    expect(manifest.library.sha256, "the library is sealed by digest").toMatch(/^[0-9a-f]{64}$/);
    expect(typeof manifest.library.sizeBytes, "the library records its size").toBe("number");
    expect(manifest.contentsSha256, "the whole contents tree is sealed by digest").toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(bundle, "lib", "liblbug.a")), "the static library is packaged").toBe(true);
    expect(existsSync(join(bundle, "include", "lbug.h")), "the flat C umbrella header is packaged").toBe(true);
    expect(existsSync(join(bundle, "include", "lbug.hpp")), "the flat C++ umbrella header is packaged").toBe(true);
    expect(existsSync(join(bundle, "include", "common", "types.h")), "the include tree keeps its nested headers").toBe(true);

    const envFile = join(fixture, "github-env-happy");
    run([
      "verify",
      "--repository", repositoryRoot,
      "--artifact-dir", bundle,
      "--github-env", envFile,
      ...identity,
    ]);
    const exported = readFileSync(envFile, "utf8");
    expect(exported, "verify exports the library directory").toContain(`LBUG_LIBRARY_DIR=${join(bundle, "lib")}`);
    expect(exported, "verify exports the include directory").toContain(`LBUG_INCLUDE_DIR=${join(bundle, "include")}`);
  });

  test("rejects every tampered or mismatched bundle before exporting any environment", () => {
    const rewriteManifest = (copy, mutate) => {
      const manifestPath = join(copy, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      mutate(manifest);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    };
    const cases = [
      {
        label: "a tampered library fails the digest check",
        copy: "tampered-lib",
        mutate: (copy) => appendFileSync(join(copy, "lib", "liblbug.a"), "tampered"),
        error: /digest does not match/,
      },
      {
        label: "a bundle built for another platform is rejected",
        args: ["--platform", "macOS-ARM64", "--rustc-release", "1.94.0"],
        error: /platform/,
      },
      {
        label: "a bundle built by another toolchain is rejected",
        args: ["--platform", "Linux-X64", "--rustc-release", "9.9.9"],
        error: /rustc/,
      },
      {
        label: "a bundle sealed against an older Cargo.lock is rejected",
        copy: "stale-lock",
        mutate: (copy) =>
          rewriteManifest(copy, (manifest) => {
            manifest.cargoLockSha256 = "0".repeat(64);
          }),
        error: /Cargo\.lock digest/,
      },
      {
        label: "a truncated include tree fails the contents digest",
        copy: "tampered-include",
        mutate: (copy) =>
          writeFileSync(join(copy, "include", "common", "types.h"), "truncated\n"),
        error: /contents digest/,
      },
      {
        label: "a library whose size does not match the manifest is rejected",
        copy: "stale-size",
        mutate: (copy) =>
          rewriteManifest(copy, (manifest) => {
            manifest.library.sizeBytes += 1;
          }),
        error: /size does not match/,
      },
      {
        label: "a directory without a manifest is rejected",
        emptyDir: "empty-bundle",
        error: /manifest\.json missing/,
      },
      {
        label: "create fails loudly when the target directory has no Ladybug build",
        mode: "create",
        error: /no build outputs|no lbug CMake output/,
      },
    ];
    expect(cases).toHaveLength(8);
    for (const row of cases) {
      if (row.mode === "create") {
        expect(
          () =>
            run([
              "create",
              "--repository", repositoryRoot,
              "--target-dir", join(fixture, "empty-target"),
              "--artifact-dir", join(fixture, "bundle-missing"),
              "--lbug-source-dir", join(fixture, "lbug-source"),
              "--source-commit", sourceCommit,
              ...identity,
            ]),
          row.label,
        ).toThrow(row.error);
        continue;
      }
      const artifactDir = row.copy
        ? tamperedCopy(row.copy)
        : join(fixture, row.emptyDir ?? "untouched");
      if (row.copy) row.mutate(artifactDir);
      if (row.emptyDir) mkdirSync(artifactDir, { recursive: true });
      const envFile = join(fixture, `github-env-${row.label.replace(/\W+/g, "-")}`);
      const args = row.args ?? [...identity];
      expect.soft(
        () =>
          run([
            "verify",
            "--repository", repositoryRoot,
            "--artifact-dir", artifactDir,
            "--github-env", envFile,
            ...args,
          ]),
        row.label,
      ).toThrow(row.error);
      expect.soft(
        existsSync(envFile),
        `${row.label}: no environment is exported before rejection`,
      ).toBe(false);
    }
  });
});
