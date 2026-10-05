import { spawn } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { preparePinnedLadybugForPackaging, requireLadybugDistributionLicenseReady, withPinnedLadybugPackagingEnvironment } from "../packaging/pinned-ladybug-build.mjs";
import { packagingBuildEnvironment } from "../packaging/build-cache.mjs";
import { installSignedNative, sealSignedNative, signedArtifactName, signedCacheProducer, signedNativeIdentity } from "../packaging/signed-native-cache.mjs";
import { restoreSignedNative } from "../packaging/signed-native-transport.mjs";

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}

export async function buildReleaseRustServers({
  contract,
  environment,
  execute = run,
  prepareLadybug = preparePinnedLadybugForPackaging,
  repositoryRoot,
  verifyLadybugDistributionLicense = requireLadybugDistributionLicenseReady,
  identify = signedNativeIdentity,
  restore = restoreSignedNative,
  capture,
  generateSymbols,
}) {
  const target = { key: contract.targetKey, rustTarget: contract.rustTarget };
  if (target.key !== "macos-arm64" && target.key !== "windows-x64") {
    throw new Error(`Ladybug release packaging is not qualified for ${target.key}.`);
  }
  await verifyLadybugDistributionLicense();
  let cache;
  if (environment.RELAYER_SIGNED_NATIVE_CACHE === "1" && target.key === "macos-arm64") {
    try {
      const producer = signedCacheProducer(environment);
      if (producer.sourceCommit !== contract.sourceCommit) throw Error("candidate/cache source mismatch");
      environment = packagingBuildEnvironment(environment);
      const identity = await identify({ repositoryRoot, environment, target });
      const directory = resolve(repositoryRoot, ".relayer/signed-native-cache-v1");
      cache = { identity, producer, directory };
      const payload = await restore({ identity, directory, environment, capture });
      if (payload) {
        await installSignedNative(payload, resolve(repositoryRoot, "target", target.rustTarget, "release"), capture);
        return payload;
      }
    } catch (error) {
      console.log(`Signed native cache: unavailable/rejected (${error.message}); compiling fresh`);
      cache = undefined;
    }
  }
  // Fetch only on an actual miss, including rejected entries. A runtime hit
  // requires neither native preparation nor the broad Cargo dependency closure.
  if (environment.GITHUB_ACTIONS === "true" || environment.RELAYER_SIGNED_NATIVE_CACHE === "1") {
    await execute("cargo", ["fetch", "--locked", "--target", target.rustTarget], { cwd: repositoryRoot, env: environment });
  }
  await withPinnedLadybugPackagingEnvironment({ environment, target, prepareLadybug }, async (
    buildEnvironment,
    cargoIntegrityArguments,
  ) => execute("cargo", [
    "build", "--release",
    "-p", "relayer-app-server",
    "-p", "relayer-graph-server",
    "--target", contract.rustTarget,
    ...cargoIntegrityArguments,
  ], {
    cwd: repositoryRoot,
    env: { ...buildEnvironment, CARGO_PROFILE_RELEASE_DEBUG: "1" },
  }));
  if (cache) {
    try {
      const payload = await sealSignedNative({ ...cache, outputDirectory: resolve(repositoryRoot, "target", target.rustTarget, "release"),
        generateSymbols, capture });
      if (environment.GITHUB_OUTPUT) await appendFile(environment.GITHUB_OUTPUT,
        `native_artifact=${signedArtifactName(cache.identity, cache.producer)}\nnative_directory=${cache.directory}\n`);
      console.log("Signed native cache: sealed fresh binaries and matching dSYMs");
      return payload;
    } catch (error) {
      // Cache storage/symbol preparation is optional. Keep the successful Cargo
      // build; ordinary telemetry generation remains the release symbol gate.
      console.log(`Signed native cache: save unavailable (${error.message}); using fresh Cargo output`);
    }
  }
  return null;
}

