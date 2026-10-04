import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  buildPinnedOpenSsl,
  createLadybugCargoEnvironment,
  digestLadybugSourceTree,
  fetchLadybugSourceCache,
  loadLadybugSourceManifest,
  stageLadybugSources,
  relativeFiles,
} from "../../scripts/prepare-ladybug-source.mjs";
import { verifyLadybugNativeReceipts } from "../../scripts/verify-ladybug-native-receipts.mjs";

import { cachedBuild, timedStage } from "./build-cache.mjs";

const PINNED_TARGETS = new Set(["macos-arm64", "windows-x64"]);

export async function requireLadybugDistributionLicenseReady({
  loadSourceManifest = loadLadybugSourceManifest,
  verifyNativeReceipts = verifyLadybugNativeReceipts,
} = {}) {
  const [manifest, nativeReceipt] = await Promise.all([
    loadSourceManifest(),
    verifyNativeReceipts(),
  ]);
  const sourceComplete = manifest?.licenseReceipt?.completeForDistribution === true;
  const nativeBlockers = Array.isArray(nativeReceipt?.releaseBlockers)
    ? nativeReceipt.releaseBlockers
    : ["invalid-native-license-receipt"];
  if (!sourceComplete || nativeBlockers.length !== 0) {
    throw new Error(
      "Ladybug distribution license receipts are not release-ready: "
      + `source complete=${sourceComplete}; native blockers=${nativeBlockers.join(",") || "none"}.`,
    );
  }
  return { manifest, nativeReceipt };
}

export async function preparePinnedLadybugForPackaging({ target, environment = process.env, cache }) {
  if (!PINNED_TARGETS.has(target.key)) {
    throw new Error(`Pinned Ladybug packaging is not qualified for ${target.key}.`);
  }
  const manifest = await loadLadybugSourceManifest();
  const sourceCache = join(tmpdir(), "relayer-ladybug-source-cache-v1");
  let temporary;
  async function build(outputDirectory) {
    await mkdir(sourceCache, { recursive: true, mode: 0o700 });
    await timedStage("pinned source fetch/verify", () => fetchLadybugSourceCache({ cacheDirectory: sourceCache, manifest }), environment);
    await timedStage("pinned source staging", () => stageLadybugSources({ cacheDirectory: sourceCache, outputDirectory, manifest }), environment);
    await timedStage("static OpenSSL build", () => buildPinnedOpenSsl({ manifest, outputDirectory, target: target.rustTarget, environment }), environment);
    // Only the reviewed lbug tree and static prefix are needed by Cargo. Configure
    // embeds this stable prefix, so cache identity binds its absolute location.
    await rm(join(outputDirectory, `openssl-${manifest.openssl.version}`), { recursive: true, force: true, maxRetries: 3 });
  }
  async function validate(outputDirectory) {
    const prefix = join(outputDirectory, "openssl-prefix");
    const suffix = target.key === "windows-x64" ? "lib" : "a";
    for (const name of [`libssl.${suffix}`, `libcrypto.${suffix}`]) {
      const info = await stat(join(prefix, "lib", name));
      if (!info.isFile() || info.size === 0) throw new Error("cached static OpenSSL archive missing or empty");
    }
    if ((await relativeFiles(prefix, prefix, [], { strict: true })).some((path) => /\.(dylib|dll|so)(\.|$)/.test(path))) throw new Error("cached OpenSSL prefix contains shared libraries");
    if (await digestLadybugSourceTree(join(outputDirectory, "lbug-0.18.0")) !== manifest.rustBinding.nativeSourceTreeSha256) {
      throw new Error("cached native source differs from reviewed lbug tree");
    }
  }
  async function fallback() {
    temporary = await mkdtemp(join(tmpdir(), "relayer-ladybug-packaging-"));
    await build(temporary);
    await validate(temporary);
    return temporary;
  }
  try {
    const outputDirectory = cache
      ? await timedStage("native cache verify/build", () => cachedBuild({ cacheRoot: cache.root, kind: "native", identity: cache.native, build, validate, fallback }), environment)
      : await fallback();
    return {
      environment: createLadybugCargoEnvironment({ manifest, outputDirectory, target: target.rustTarget }),
      environmentMustBeUnset: manifest.build.environmentMustBeUnset,
      dispose: () => temporary ? rm(temporary, { recursive: true, force: true }) : Promise.resolve(),
    };
  } catch (error) {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function withPinnedLadybugPackagingEnvironment({
  environment,
  target,
  prepareLadybug = preparePinnedLadybugForPackaging,
}, operation) {
  if (!PINNED_TARGETS.has(target.key)) return operation(environment, []);
  if (environment.RUSTFLAGS || environment.CARGO_ENCODED_RUSTFLAGS) {
    throw new Error("Pinned Ladybug packaging rejects ambient Rust compiler flags.");
  }
  const manifest = await loadLadybugSourceManifest();
  const prepared = await prepareLadybug({ environment, target });
  const pinned = prepared?.environment;
  if (!pinned
    || !isAbsolute(pinned.OPENSSL_DIR || "")
    || !isAbsolute(pinned.LBUG_SOURCE_DIR || "")
    || pinned.OPENSSL_STATIC !== "1"
    || pinned.LBUG_BUILD_FROM_SOURCE !== "1"
    || pinned.CARGO_NET_OFFLINE !== "true") {
    await prepared?.dispose?.();
    throw new Error("Pinned packaging requires the complete pinned static Ladybug/OpenSSL environment.");
  }
  const buildEnvironment = { ...environment };
  for (const name of prepared.environmentMustBeUnset ?? manifest.build.environmentMustBeUnset) {
    delete buildEnvironment[name];
  }
  delete buildEnvironment.OPENSSL_DIR;
  delete buildEnvironment.OPENSSL_LIB_DIR;
  Object.assign(buildEnvironment, pinned);
  try {
    return await operation(buildEnvironment, ["--locked", "--offline"]);
  } finally {
    await prepared.dispose?.();
  }
}
