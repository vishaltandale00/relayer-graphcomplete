import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { buildDevelopmentDesktop } from "../desktop/packaging/build-development.mjs";
import {
  captureLadybugPackagedLifecycle,
  npmEnvironmentForDesktopTarget,
  parseMachOArchitectures,
  qualificationLifecycleTimeout,
  parseLadybugLockContention,
  parseDynamicLibraries,
  parseMinimumMacOSVersion,
  validatePreparedLadybugSource,
  verifyNoRuntimePaths,
  verifySystemOnlyDynamicLibraries,
} from "../scripts/capture-ladybug-packaged-lifecycle.mjs";
import {
  createLadybugCargoEnvironment,
  digestLadybugSourceTree,
  loadLadybugSourceManifest,
  sha256File,
} from "../scripts/prepare-ladybug-source.mjs";

const execFileAsync = promisify(execFile);
const receiptInputPaths = [
  "Cargo.lock",
  "crates/relayer-graph-server/Cargo.toml",
  "crates/relayer-graph-server/src/main.rs",
  "desktop/packaging/build-development.mjs",
  "desktop/shared/target.mjs",
  "scripts/capture-ladybug-packaged-lifecycle.mjs",
  "scripts/prepare-ladybug-source.mjs",
  "vendor/ladybug/source-build-manifest.json",
].sort();
const receiptFields = [
  "application", "binary", "binaryArchitectures", "binarySha256", "buildIsolation",
  "capturedOn", "cleanProfileCreated", "cleanShutdown", "dependencyIsolation",
  "dynamicLibraries", "executionMode", "hostArchitecture", "inputSha256", "lbug",
  "lifecycleTimeoutMs", "limitations", "lockContentionRejected", "lockFailure",
  "minimumMacOSVersion", "nativeMode", "preparedReceiptSha256", "preparedSourceSha256",
  "restartReopenedPersistedMarker", "rustTarget", "schemaVersion", "scope", "sourceCommit",
  "storageVersion", "target",
].sort();

function verifyReceiptShape(receipt, targetExpectation) {
  const { limitation, ...receiptExpectation } = targetExpectation;
  expect(Object.keys(receipt).sort()).toEqual(receiptFields);
  expect(Object.keys(receipt.inputSha256).sort()).toEqual(receiptInputPaths);
  expect(Object.keys(receipt.preparedReceiptSha256).sort()).toEqual([
    "cargo-build-env.json", "source-receipt.json",
  ]);
  expect(receipt.preparedSourceSha256).toEqual({
    ladybugCoreTree: "c90c2bd925e72dcc6c9e51c17b1a150589e719c949d364ded4a98389f0aabe62",
  });
  expect(receipt.binarySha256).toMatch(/^[0-9a-f]{64}$/u);
  expect(receipt.capturedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  expect(receipt.dynamicLibraries).toEqual([
    "/usr/lib/libc++.1.dylib",
    "/usr/lib/libiconv.2.dylib",
    "/usr/lib/libSystem.B.dylib",
  ]);
  expect(receipt.limitations).toEqual([
    limitation,
    "unsigned development package",
    "not release-ready licensing evidence",
  ]);
  expect(parseLadybugLockContention(receipt.lockFailure)).toBe(receipt.lockFailure);
  expect(receipt).toMatchObject({
    ...receiptExpectation,
    schemaVersion: 1,
    scope: "issue-261-local-packaged-qualification",
    application: "Relayer Dev.app",
    binary: "Contents/Resources/bin/relayer-graph-server",
    buildIsolation: "clean-detached-worktree-and-empty-cargo-target",
    dependencyIsolation: "locked-offline-npm-ci-and-generated-assets",
    nativeMode: "fully-static-ladybug-and-openssl",
    minimumMacOSVersion: "13.3",
    cleanProfileCreated: true,
    lockContentionRejected: true,
    cleanShutdown: true,
    restartReopenedPersistedMarker: true,
    storageVersion: 42,
    lbug: { version: "0.18.0", extensions: [] },
  });
}

describe("Ladybug packaged lifecycle qualification", () => {
  it("gives every cold packaged launch one recorded bounded window", () => {
    expect(qualificationLifecycleTimeout({ architecture: "arm64" }, "arm64")).toBe(15_000);
    expect(qualificationLifecycleTimeout({ architecture: "x64" }, "arm64")).toBe(15_000);
  });
  it("installs the dependency closure for the packaged architecture", () => {
    expect(npmEnvironmentForDesktopTarget(
      { PATH: "/bin" },
      { platform: "darwin", architecture: "x64" },
    )).toEqual({ PATH: "/bin", npm_config_os: "darwin", npm_config_cpu: "x64" });
  });
  it("recognizes lock contention across the pinned Ladybug message variants", () => {
    expect(parseLadybugLockContention(
      "IO exception: Could not set lock on file : /tmp/db (Lock is held by PID 42)",
    )).toContain("Lock is held by PID 42");
    expect(parseLadybugLockContention(
      "IO exception: Could not set lock on file : /tmp/db: Resource temporarily unavailable",
    )).toContain("Resource temporarily unavailable");
    expect(() => parseLadybugLockContention("permission denied")).toThrow("not Ladybug lock contention");
  });
  it("requires a full immutable source commit before preparing a package", async () => {
    await expect(captureLadybugPackagedLifecycle({
      sourceOutput: "/tmp/not-read-for-invalid-commit",
      sourceCommit: "61ee3b3",
    })).rejects.toThrow("exact 40-character source commit");
  });

  it("binds both isolated macOS captures to their exact committed qualification inputs", async () => {
    const expectations = [
      ["issue-261-ladybug-packaged-arm64.json", {
        target: "macos-arm64",
        rustTarget: "aarch64-apple-darwin",
        hostArchitecture: "arm64",
        executionMode: "native",
        binaryArchitectures: ["arm64"],
        lifecycleTimeoutMs: 15_000,
        limitation: "local macos-arm64 native execution only",
      }],
      ["issue-261-ladybug-packaged-intel.json", {
        target: "macos-x64",
        rustTarget: "x86_64-apple-darwin",
        hostArchitecture: "arm64",
        executionMode: "rosetta",
        binaryArchitectures: ["x86_64"],
        lifecycleTimeoutMs: 15_000,
        limitation: "local macos-x64 Rosetta execution only",
      }],
    ];
    const sourceCommits = new Set();

    for (const [file, targetExpectation] of expectations) {
      const receipt = JSON.parse(await readFile(`docs/evidence/${file}`, "utf8"));
      verifyReceiptShape(receipt, targetExpectation);
      expect(receipt.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
      sourceCommits.add(receipt.sourceCommit);
      for (const [path, expected] of Object.entries(receipt.inputSha256)) {
        const { stdout } = await execFileAsync("git", ["show", `${receipt.sourceCommit}:${path}`], {
          encoding: "buffer",
          maxBuffer: 10 * 1024 * 1024,
        });
        expect(createHash("sha256").update(stdout).digest("hex"), `${file}:${path}`).toBe(expected);
      }
      for (const expected of [
        ...Object.values(receipt.preparedReceiptSha256),
        ...Object.values(receipt.preparedSourceSha256),
      ]) {
        expect(expected).toMatch(/^[0-9a-f]{64}$/u);
      }
    }
    expect(sourceCommits).toEqual(new Set(["23a2d3d176d4e29330a3154d071b365881abf017"]));
  });

  it("rejects omitted or mutated packaged receipt authority fields", async () => {
    const receipt = JSON.parse(await readFile(
      "docs/evidence/issue-261-ladybug-packaged-arm64.json",
      "utf8",
    ));
    const expectation = {
      target: "macos-arm64",
      rustTarget: "aarch64-apple-darwin",
      hostArchitecture: "arm64",
      executionMode: "native",
      binaryArchitectures: ["arm64"],
      lifecycleTimeoutMs: 15_000,
      limitation: "local macos-arm64 native execution only",
    };
    expect(() => verifyReceiptShape({ ...receipt, inputSha256: {} }, expectation)).toThrow();
    expect(() => verifyReceiptShape({ ...receipt, preparedReceiptSha256: {} }, expectation)).toThrow();
    expect(() => verifyReceiptShape({ ...receipt, binaryArchitectures: ["x86_64"] }, expectation)).toThrow();
    expect(() => verifyReceiptShape({ ...receipt, limitations: [] }, expectation)).toThrow();
  });

  it("accepts only system dynamic-library imports", () => {
    const libraries = parseDynamicLibraries(`bin:
\t/usr/lib/libiconv.2.dylib (compatibility version 7.0.0, current version 7.0.0)
\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1900.178.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.100.2)
`);
    expect(verifySystemOnlyDynamicLibraries(libraries)).toEqual([
      "/usr/lib/libiconv.2.dylib",
      "/usr/lib/libc++.1.dylib",
      "/usr/lib/libSystem.B.dylib",
    ]);
  });

  it("rejects packaged Ladybug or OpenSSL dylibs", () => {
    expect(() => verifySystemOnlyDynamicLibraries([
      "/Applications/Relayer DEV.app/Contents/Frameworks/liblbug.dylib",
    ])).toThrow("non-system dynamic libraries");
    expect(() => verifySystemOnlyDynamicLibraries(["/opt/homebrew/opt/openssl/lib/libssl.3.dylib"]))
      .toThrow("non-system dynamic libraries");
  });

  it("reads the packaged Mach-O minimum operating system", () => {
    expect(parseMinimumMacOSVersion(`Load command 10
          cmd LC_BUILD_VERSION
      cmdsize 32
     platform 1
        minos 13.3
          sdk 26.0
`)).toBe("13.3");
    expect(() => parseMinimumMacOSVersion("no build version")).toThrow("omits LC_BUILD_VERSION");
  });

  it("reads the exact packaged Mach-O architecture", () => {
    expect(parseMachOArchitectures("x86_64\n")).toEqual(["x86_64"]);
    expect(parseMachOArchitectures("arm64 x86_64\n")).toEqual(["arm64", "x86_64"]);
    expect(() => parseMachOArchitectures("\n")).toThrow("no Mach-O architecture");
  });

  it("rejects every Mach-O runtime search path", () => {
    expect(() => verifyNoRuntimePaths(`Load command 11
          cmd LC_RPATH
      cmdsize 48
         path @loader_path (offset 12)
`)).toThrow("forbidden LC_RPATH");
    expect(verifyNoRuntimePaths("Load command 10\n      cmd LC_BUILD_VERSION\n")).toBeUndefined();
  });

  it("passes locked offline Cargo arguments only for qualification packaging", async () => {
    const calls = [];
    await buildDevelopmentDesktop({
      environment: {
        RELAYER_DESKTOP_TARGET: "macos-arm64",
        RELAYER_LADYBUG_QUALIFICATION: "1",
        OPENSSL_DIR: "/tmp/prepared-openssl",
      },
      execute: async (command, args, options) => calls.push({ command, args, options }),
      repositoryRoot: "/tmp/exact-source",
      dependencyRoot: "/tmp/dependencies",
    });
    expect(calls[0].command).toBe("cargo");
    expect(calls[0].args).toEqual([
      "build", "--release",
      "-p", "relayer-app-server",
      "-p", "relayer-graph-server",
      "--target", "aarch64-apple-darwin",
      "--locked", "--offline",
    ]);
    expect(calls[0].options.env.RUSTFLAGS).toBeUndefined();
    expect(calls[0].options.env.CARGO_ENCODED_RUSTFLAGS.split("\u001f")).toEqual([
      "--cfg", "ladybug_qualification",
      "-L", "native=/tmp/prepared-openssl/lib",
      "-l", "static=ssl",
      "-l", "static=crypto",
    ]);
    expect(calls[0].options.cwd).toBe("/tmp/exact-source");
    expect(calls[1].args[0]).toBe("/tmp/dependencies/node_modules/electron-builder/out/cli/cli.js");
  });

  it("maps the prepared OpenSSL archives to MSVC static library names", async () => {
    const calls = [];
    await buildDevelopmentDesktop({
      environment: {
        RELAYER_DESKTOP_TARGET: "windows-x64",
        RELAYER_LADYBUG_QUALIFICATION: "1",
        OPENSSL_DIR: "/tmp/prepared-openssl",
      },
      execute: async (command, args, options) => calls.push({ command, args, options }),
      repositoryRoot: "/tmp/exact-source",
      dependencyRoot: "/tmp/dependencies",
    });
    expect(calls[0].options.env.CARGO_ENCODED_RUSTFLAGS.split("\u001f")).toEqual([
      "--cfg", "ladybug_qualification",
      "-L", "native=/tmp/prepared-openssl/lib",
      "-l", "static=libssl",
      "-l", "static=libcrypto",
    ]);
  });

  it("rejects qualification without the prepared static OpenSSL prefix", async () => {
    await expect(buildDevelopmentDesktop({
      environment: {
        RELAYER_DESKTOP_TARGET: "macos-arm64",
        RELAYER_LADYBUG_QUALIFICATION: "1",
      },
      execute: async () => {},
    })).rejects.toThrow("requires the prepared static OPENSSL_DIR");
  });

  it("rejects prepared environments or static archives that differ from recomputed inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-ladybug-capture-test-"));
    try {
      const manifest = await loadLadybugSourceManifest();
      const ladybugCore = join(root, "lbug-0.18.0", "lbug-src");
      await mkdir(ladybugCore, { recursive: true });
      await writeFile(join(ladybugCore, "reviewed.cpp"), "reviewed Ladybug core");
      manifest.core.embeddedTreeSha256 = await digestLadybugSourceTree(ladybugCore);
      const lib = join(root, "openssl-prefix", "lib");
      await mkdir(lib, { recursive: true });
      await writeFile(join(lib, "libssl.a"), "reviewed ssl");
      await writeFile(join(lib, "libcrypto.a"), "reviewed crypto");
      await writeFile(join(root, "source-receipt.json"), "{}\n");
      const environment = createLadybugCargoEnvironment({
        manifest,
        outputDirectory: root,
        target: "aarch64-apple-darwin",
      });
      const receipt = {
        schemaVersion: 1,
        target: "aarch64-apple-darwin",
        cargoArguments: ["build", "--locked", "--offline"],
        environment,
        environmentMustBeUnset: manifest.build.environmentMustBeUnset,
        artifacts: await Promise.all(["libssl.a", "libcrypto.a"].map(async (file) => ({
          file: `openssl-prefix/lib/${file}`,
          sha256: await sha256File(join(lib, file)),
        }))),
        requiredRuntimeRpath: null,
      };
      await writeFile(join(root, "cargo-build-env.json"), `${JSON.stringify(receipt)}\n`);
      await expect(validatePreparedLadybugSource({
        sourceOutput: root,
        manifest,
        target: "aarch64-apple-darwin",
      })).resolves.toMatchObject({ cargoEnvironment: receipt });

      await writeFile(join(ladybugCore, "reviewed.cpp"), "mutated Ladybug core");
      await expect(validatePreparedLadybugSource({
        sourceOutput: root,
        manifest,
        target: "aarch64-apple-darwin",
      })).rejects.toThrow("differs from the reviewed source tree");
      await writeFile(join(ladybugCore, "reviewed.cpp"), "reviewed Ladybug core");

      receipt.environment.LBUG_SOURCE_DIR = "/tmp/ambient-ladybug";
      await writeFile(join(root, "cargo-build-env.json"), `${JSON.stringify(receipt)}\n`);
      await expect(validatePreparedLadybugSource({
        sourceOutput: root,
        manifest,
        target: "aarch64-apple-darwin",
      })).rejects.toThrow("recomputed pinned paths");

      receipt.environment = createLadybugCargoEnvironment({
        manifest,
        outputDirectory: root,
        target: "aarch64-apple-darwin",
      });
      await writeFile(join(root, "cargo-build-env.json"), `${JSON.stringify(receipt)}\n`);
      await writeFile(join(lib, "libssl.a"), "ambient replacement");
      await expect(validatePreparedLadybugSource({
        sourceOutput: root,
        manifest,
        target: "aarch64-apple-darwin",
      })).rejects.toThrow("differs from its prepared digest");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
