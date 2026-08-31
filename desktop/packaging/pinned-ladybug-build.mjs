import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  buildPinnedOpenSsl,
  fetchLadybugSourceCache,
  loadLadybugSourceManifest,
  stageLadybugSources,
} from "../../scripts/prepare-ladybug-source.mjs";

const QUALIFIED_TARGET = "macos-arm64";

export async function preparePinnedLadybugForPackaging({ target }) {
  if (target.key !== QUALIFIED_TARGET) {
    throw new Error(`Pinned Ladybug packaging is not qualified for ${target.key}.`);
  }
  const manifest = await loadLadybugSourceManifest();
  const cacheDirectory = join(tmpdir(), "relayer-ladybug-source-cache-v1");
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  await fetchLadybugSourceCache({ cacheDirectory, manifest });
  const outputDirectory = await mkdtemp(join(tmpdir(), "relayer-ladybug-packaging-"));
  try {
    await stageLadybugSources({ cacheDirectory, outputDirectory, manifest });
    const prepared = await buildPinnedOpenSsl({
      manifest,
      outputDirectory,
      target: target.rustTarget,
    });
    return {
      environment: prepared.environment,
      environmentMustBeUnset: manifest.build.environmentMustBeUnset,
      dispose: () => rm(outputDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function withPinnedLadybugPackagingEnvironment({
  environment,
  target,
  prepareLadybug = preparePinnedLadybugForPackaging,
}, operation) {
  if (target.key !== QUALIFIED_TARGET) return operation(environment, []);
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
    throw new Error("Apple-Silicon packaging requires the complete pinned static Ladybug/OpenSSL environment.");
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
