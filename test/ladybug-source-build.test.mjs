import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c as createTar } from "tar";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLadybugCargoEnvironment,
  digestLadybugSourceTree,
  loadLadybugSourceManifest,
  sha256File,
  stageLadybugSources,
  validateLadybugSourceManifest,
  verifyLadybugSourceCache,
} from "../scripts/prepare-ladybug-source.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "relayer-ladybug-source-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("pinned Ladybug source build", () => {
  it("freezes an unpatched binding, embedded core, static OpenSSL, and zero extensions", async () => {
    const manifest = await loadLadybugSourceManifest();

    expect(manifest).toMatchObject({
      core: {
        version: "0.19.1",
        commit: "554c1e71158564c37a30c541a92bfc9eddc96430",
      },
      rustBinding: {
        crate: "lbug",
        version: "0.19.1",
        sha256: "a7a032d5968ac2260545e8c5cf05a123559de2c6ba2bd0dde11c0ed958dfa172",
      },
      openssl: {
        version: "3.5.8",
        sha256: "a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2",
      },
      extensions: [],
      build: {
        nativeMode: "fully-static-ladybug-and-openssl",
        minimumMacOSVersion: "13.3",
        cargoNetworkMode: "offline",
        environmentMustBeUnset: [
          "LBUG_GITHUB_REPOSITORY",
          "LBUG_INCLUDE_DIR",
          "LBUG_LIBRARY_DIR",
          "LBUG_PRECOMPILED_RUN_ID",
          "LBUG_RUST_BUILD_FROM_SOURCE",
          "LBUG_SHARED",
        ],
        bindingPatch: null,
        corePatch: null,
      },
      runtime: {
        ladybugLibraryKind: "static",
        packagedLadybugLibrary: null,
        requiredPackagedRpath: null,
        externalOpenSSLLibraries: false,
      },
      evidence: {
        macOSArm64Observation: "docs/evidence/issue-261-ladybug-source-arm64.txt",
        macOSArm64ObservationSha256: "ec0832b0f17faca44a61aebe518b490dc58c301187fc668eb548604971864d7e",
      },
      licenseReceipt: { completeForDistribution: false },
    });

    const observation = await readFile(manifest.evidence.macOSArm64Observation);
    expect(createHash("sha256").update(observation).digest("hex"))
      .toBe(manifest.evidence.macOSArm64ObservationSha256);

    const environment = createLadybugCargoEnvironment({
      manifest,
      outputDirectory: "/tmp/reviewed-ladybug-stage",
      target: "aarch64-apple-darwin",
    });
    expect(environment).toMatchObject({
      CARGO_NET_OFFLINE: "true",
      LBUG_BUILD_FROM_SOURCE: "1",
      LBUG_VERSION: "0.19.1",
      LIBRARY_PATH: "/tmp/reviewed-ladybug-stage/openssl-prefix/lib",
      MACOSX_DEPLOYMENT_TARGET: "13.3",
      OPENSSL_STATIC: "1",
      OPENSSL_USE_STATIC_LIBS: "TRUE",
    });
    expect(environment).not.toHaveProperty("LBUG_SHARED");
    expect(environment).not.toHaveProperty("LBUG_OPENSSL_STATIC_ROOT");
    expect(() => createLadybugCargoEnvironment({
      manifest,
      outputDirectory: "/tmp/reviewed-ladybug-stage",
      target: "x86_64-pc-windows-msvc",
    })).toThrow(/blocked.*unmodified lbug 0\.19\.1/u);
  });

  it("rejects source cache bytes that do not match the frozen checksums", async () => {
    const manifest = structuredClone(await loadLadybugSourceManifest());
    const cacheDirectory = await temporaryDirectory();
    await writeFile(join(cacheDirectory, manifest.rustBinding.archive), "wrong binding bytes");
    await writeFile(join(cacheDirectory, manifest.openssl.archive), "wrong OpenSSL bytes");

    await expect(verifyLadybugSourceCache({ cacheDirectory, manifest })).rejects.toThrow(
      /lbug-0\.19\.1\.crate SHA-256 mismatch/u,
    );
  });

  it("stages reviewed archive bytes without modifying the binding or embedded core", async () => {
    const root = await temporaryDirectory();
    const cacheDirectory = join(root, "cache");
    const fixtureDirectory = join(root, "fixture");
    const outputDirectory = join(root, "output");
    const bindingRoot = join(fixtureDirectory, "lbug-0.19.1");
    const opensslRoot = join(fixtureDirectory, "openssl-3.5.8");
    await mkdir(join(bindingRoot, "lbug-src", "src"), { recursive: true });
    await mkdir(opensslRoot, { recursive: true });
    await mkdir(cacheDirectory);
    await writeFile(join(bindingRoot, "build.rs"), "fn main() {}\n");
    await writeFile(join(bindingRoot, "lbug-src", "CMakeLists.txt"), "project(lbug)\n");
    await writeFile(join(bindingRoot, "lbug-src", "src", "core.cpp"), "// core\n");
    await writeFile(join(opensslRoot, "Configure"), "#!/usr/bin/env perl\n");

    const manifest = structuredClone(await loadLadybugSourceManifest());
    manifest.core.embeddedTreeSha256 = await digestLadybugSourceTree(join(bindingRoot, "lbug-src"));
    manifest.rustBinding.buildScriptSha256 = await sha256File(join(bindingRoot, "build.rs"));
    await createTar({
      cwd: fixtureDirectory,
      file: join(cacheDirectory, manifest.rustBinding.archive),
      gzip: true,
    }, ["lbug-0.19.1"]);
    await createTar({
      cwd: fixtureDirectory,
      file: join(cacheDirectory, manifest.openssl.archive),
      gzip: true,
    }, ["openssl-3.5.8"]);
    manifest.rustBinding.sha256 = await sha256File(join(cacheDirectory, manifest.rustBinding.archive));
    manifest.openssl.sha256 = await sha256File(join(cacheDirectory, manifest.openssl.archive));

    const staged = await stageLadybugSources({ cacheDirectory, outputDirectory, manifest });
    expect(staged.receipt).toMatchObject({
      core: { version: "0.19.1", embeddedTreeSha256: manifest.core.embeddedTreeSha256 },
      rustBinding: { crate: "lbug", version: "0.19.1", patched: false },
      openssl: { version: "3.5.8", sha256: manifest.openssl.sha256 },
      extensions: [],
      nativeMode: "fully-static-ladybug-and-openssl",
      distributionLicenseReceiptComplete: false,
    });
    expect(await readFile(join(staged.bindingDirectory, "build.rs"), "utf8")).toBe("fn main() {}\n");
    expect(JSON.parse(await readFile(join(outputDirectory, "source-receipt.json"), "utf8")))
      .toEqual(staged.receipt);
  });

  it("rejects a binding patch, a core patch, extensions, or an online Cargo mode", async () => {
    const original = await loadLadybugSourceManifest();
    for (const mutate of [
      (manifest) => { manifest.build.bindingPatch = "local.patch"; },
      (manifest) => { manifest.build.corePatch = "local.patch"; },
      (manifest) => { manifest.extensions = ["vector"]; },
      (manifest) => { manifest.build.cargoNetworkMode = "online"; },
      (manifest) => { manifest.build.nativeMode = "shared-ladybug-with-static-openssl"; },
      (manifest) => { manifest.build.environmentMustBeUnset = []; },
      (manifest) => { manifest.build.targets["x86_64-pc-windows-msvc"].supported = true; },
    ]) {
      const manifest = structuredClone(original);
      mutate(manifest);
      expect(() => validateLadybugSourceManifest(manifest)).toThrow();
    }
  });
});
