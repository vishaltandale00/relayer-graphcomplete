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
import { DESKTOP_RELEASE } from "../desktop/release/contract.mjs";

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

// macOS release -> Darwin kernel version. Apple's mapping is not a formula
// (macOS 13.0 is Darwin 22.1, but 14.0 is Darwin 23.0), so every floor Relayer
// may adopt is listed explicitly. Moving the floor means adding its pair here,
// which is the point: it forces the update-manifest version to move with it.
const DARWIN_KERNEL_FOR_MACOS = {
  "13.0.0": "22.1.0",
  "13.3.0": "22.4.0",
  "14.0.0": "23.0.0",
  "15.0.0": "24.0.0",
};

describe("pinned Ladybug source build", () => {
  it("freezes the source contract, stages reviewed archives byte-exactly, and fails closed on every mutation", async () => {
    const manifest = await loadLadybugSourceManifest();
    const floor = DESKTOP_RELEASE.minimumMacOSVersion;

    // The Ladybug source build compiles with -mmacosx-version-min from its own
    // manifest; if that drifts below the product floor the binary silently
    // targets an older OS than the app claims to require.
    expect(`${manifest.build.minimumMacOSVersion}`, "Ladybug build floor matches the desktop floor").toBe(floor.split(".").slice(0, 2).join("."));

    // electron-updater gates on the Darwin kernel version, not the macOS one.
    // Apple's mapping is not a formula (macOS 13.0 is Darwin 22.1, but 14.0 is
    // Darwin 23.0), so every floor Relayer may adopt is listed explicitly in
    // DARWIN_KERNEL_FOR_MACOS; moving the floor means adding its pair there.
    expect(DARWIN_KERNEL_FOR_MACOS, `no Darwin kernel recorded for macOS ${floor}`)
      .toHaveProperty(floor);
    expect(DESKTOP_RELEASE.minimumUpdateSystemVersion, "update gate uses the Darwin translation").toBe(DARWIN_KERNEL_FOR_MACOS[floor]);

    expect(manifest, "frozen unpatched binding, embedded core, static OpenSSL, zero extensions").toMatchObject({
      core: {
        version: "0.18.0",
        commit: "0cda4fffcebb4a52cc24198462901ad28e2d5b66",
      },
      rustBinding: {
        crate: "lbug",
        version: "0.18.0",
        sha256: "f52ee74966e323212747aa22fa8c01f73f1cbbb996187c3b08cbf96ff9f67562",
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
        platformLinkAdapter: {
          ownership: "relayer",
          ladybugSourcePatched: false,
          targets: [
            { rustTarget: "aarch64-apple-darwin", libraryDirectory: "openssl-prefix/lib", staticLibraries: ["ssl", "crypto"] },
            { rustTarget: "x86_64-apple-darwin", libraryDirectory: "openssl-prefix/lib", staticLibraries: ["ssl", "crypto"] },
            { rustTarget: "x86_64-pc-windows-msvc", libraryDirectory: "openssl-prefix/lib", staticLibraries: ["libssl", "libcrypto"] },
          ],
        },
      },
      runtime: {
        ladybugLibraryKind: "static",
        packagedLadybugLibrary: null,
        requiredPackagedRpath: null,
        externalOpenSSLLibraries: false,
      },
      licenseReceipt: { completeForDistribution: false },
    });

    const environment = createLadybugCargoEnvironment({
      manifest,
      outputDirectory: "/tmp/reviewed-ladybug-stage",
      target: "aarch64-apple-darwin",
    });
    expect(environment, "offline static cargo environment for Apple Silicon").toMatchObject({
      CARGO_NET_OFFLINE: "true",
      LBUG_BUILD_FROM_SOURCE: "1",
      LBUG_VERSION: "0.18.0",
      LIBRARY_PATH: "/tmp/reviewed-ladybug-stage/openssl-prefix/lib",
      MACOSX_DEPLOYMENT_TARGET: "13.3",
      OPENSSL_STATIC: "1",
      OPENSSL_USE_STATIC_LIBS: "TRUE",
    });
    expect(environment, "no shared Ladybug linkage").not.toHaveProperty("LBUG_SHARED");
    expect(environment, "no ambient OpenSSL root").not.toHaveProperty("LBUG_OPENSSL_STATIC_ROOT");
    expect(createLadybugCargoEnvironment({
      manifest,
      outputDirectory: "/tmp/reviewed-ladybug-stage",
      target: "x86_64-pc-windows-msvc",
    }), "Windows target keeps the pinned library path").toMatchObject({
      LBUG_VERSION: "0.18.0",
      LIBRARY_PATH: "/tmp/reviewed-ladybug-stage/openssl-prefix/lib",
    });

    const mutations = [
      ["a binding patch", (candidate) => { candidate.build.bindingPatch = "local.patch"; }],
      ["a core patch", (candidate) => { candidate.build.corePatch = "local.patch"; }],
      ["extensions", (candidate) => { candidate.extensions = ["vector"]; }],
      ["an online Cargo mode", (candidate) => { candidate.build.cargoNetworkMode = "online"; }],
      ["a shared Ladybug native mode", (candidate) => { candidate.build.nativeMode = "shared-ladybug-with-static-openssl"; }],
      ["a dropped environment guard", (candidate) => { candidate.build.environmentMustBeUnset = []; }],
      ["ladybug-owned link adapter", (candidate) => { candidate.build.platformLinkAdapter.ownership = "ladybug"; }],
      ["renamed Windows static libraries", (candidate) => { candidate.build.platformLinkAdapter.targets[2].staticLibraries = ["ssl", "crypto"]; }],
      ["a disabled Windows release target", (candidate) => { candidate.build.targets["x86_64-pc-windows-msvc"].supported = false; }],
    ];
    expect(mutations, "manifest mutation inventory").toHaveLength(9);
    for (const [label, mutate] of mutations) {
      const candidate = structuredClone(manifest);
      mutate(candidate);
      expect(() => validateLadybugSourceManifest(candidate), `manifest rejects ${label}`).toThrow();
    }

    const cacheManifest = structuredClone(manifest);
    const cacheDirectory = await temporaryDirectory();
    await writeFile(join(cacheDirectory, cacheManifest.rustBinding.archive), "wrong binding bytes");
    await writeFile(join(cacheDirectory, cacheManifest.openssl.archive), "wrong OpenSSL bytes");
    await expect(
      verifyLadybugSourceCache({ cacheDirectory, manifest: cacheManifest }),
      "source cache bytes must match the frozen checksums",
    ).rejects.toThrow(/lbug-0\.18\.0\.crate SHA-256 mismatch/u);

    const root = await temporaryDirectory();
    const stagingCacheDirectory = join(root, "cache");
    const fixtureDirectory = join(root, "fixture");
    const outputDirectory = join(root, "output");
    const bindingRoot = join(fixtureDirectory, "lbug-0.18.0");
    const opensslRoot = join(fixtureDirectory, "openssl-3.5.8");
    await mkdir(join(bindingRoot, "lbug-src", "src"), { recursive: true });
    await mkdir(opensslRoot, { recursive: true });
    await mkdir(stagingCacheDirectory);
    await writeFile(join(bindingRoot, "build.rs"), "fn main() {}\n");
    await writeFile(join(bindingRoot, "lbug-src", "CMakeLists.txt"), "project(lbug)\n");
    await writeFile(join(bindingRoot, "lbug-src", "src", "core.cpp"), "// core\n");
    await writeFile(join(opensslRoot, "Configure"), "#!/usr/bin/env perl\n");

    const stagingManifest = structuredClone(manifest);
    stagingManifest.core.embeddedTreeSha256 = await digestLadybugSourceTree(join(bindingRoot, "lbug-src"));
    stagingManifest.rustBinding.buildScriptSha256 = await sha256File(join(bindingRoot, "build.rs"));
    await createTar({
      cwd: fixtureDirectory,
      file: join(stagingCacheDirectory, stagingManifest.rustBinding.archive),
      gzip: true,
    }, ["lbug-0.18.0"]);
    await createTar({
      cwd: fixtureDirectory,
      file: join(stagingCacheDirectory, stagingManifest.openssl.archive),
      gzip: true,
    }, ["openssl-3.5.8"]);
    stagingManifest.rustBinding.sha256 = await sha256File(join(stagingCacheDirectory, stagingManifest.rustBinding.archive));
    stagingManifest.openssl.sha256 = await sha256File(join(stagingCacheDirectory, stagingManifest.openssl.archive));

    const staged = await stageLadybugSources({ cacheDirectory: stagingCacheDirectory, outputDirectory, manifest: stagingManifest });
    expect(staged.receipt, "staging receipt for reviewed archives").toMatchObject({
      core: { version: "0.18.0", embeddedTreeSha256: stagingManifest.core.embeddedTreeSha256 },
      rustBinding: { crate: "lbug", version: "0.18.0", patched: false },
      openssl: { version: "3.5.8", sha256: stagingManifest.openssl.sha256 },
      extensions: [],
      nativeMode: "fully-static-ladybug-and-openssl",
      distributionLicenseReceiptComplete: false,
    });
    expect(await readFile(join(staged.bindingDirectory, "build.rs"), "utf8"), "binding staged without modification").toBe("fn main() {}\n");
    expect(JSON.parse(await readFile(join(outputDirectory, "source-receipt.json"), "utf8")), "persisted source receipt matches")
      .toEqual(staged.receipt);
  }, 30_000);
});
