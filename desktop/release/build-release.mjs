import { spawn } from "node:child_process";
import { appendFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeDesktopReleaseEvidence, verifyDesktopReleaseEvidence } from "./artifacts.mjs";
import { desktopReleaseAppPath } from "./app-path.mjs";
import { loadDesktopReleaseContract } from "./contract.mjs";
import { finalizeDesktopUpdateArtifact } from "./finalize-update-artifact.mjs";
import { notarizeAndStapleDesktopDMGs } from "./notarize-and-staple.mjs";
import { prepareDesktopTelemetryArtifacts } from "./telemetry-artifacts.mjs";
import { verifyMacOSApplication } from "./verify-macos-app.mjs";
import { verifyPackagedDesktopContract } from "./verify-packaged-contract.mjs";
import { verifyDesktopUpdateZip } from "./verify-update-zip.mjs";
import { verifyWindowsRelease } from "./verify-windows-app.mjs";
import {
  preparePinnedLadybugForPackaging,
  requireLadybugDistributionLicenseReady,
  withPinnedLadybugPackagingEnvironment,
} from "../packaging/pinned-ladybug-build.mjs";

import { packagingBuildEnvironment } from "../packaging/build-cache.mjs";
import { installSignedNative, sealSignedNative, signedArtifactName, signedCacheProducer, signedNativeIdentity } from "../packaging/signed-native-cache.mjs";
import { restoreSignedNative } from "../packaging/signed-native-transport.mjs";
import { windowsNativeHandoffContext, writeWindowsNativeHandoff, verifyWindowsNativeHandoff } from "./windows-native-handoff.mjs";

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

async function cacheOutcome(environment, outcome) {
  console.log(`Signed native cache outcome: ${outcome}`);
  try {
    if (environment.GITHUB_OUTPUT) await appendFile(environment.GITHUB_OUTPUT, `native_cache_outcome=${outcome}\n`);
    if (environment.GITHUB_STEP_SUMMARY) await appendFile(environment.GITHUB_STEP_SUMMARY, `- Signed native cache: ${outcome}\n`);
  } catch { /* Optional diagnostic transport cannot change compilation. */ }
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
        await cacheOutcome(environment, "verified-hit; native compilation skipped");
        return payload;
      }
      await cacheOutcome(environment, "lookup-miss; compiling fresh");
    } catch (error) {
      console.log(`Signed native cache: unavailable/rejected (${error.message}); compiling fresh`);
      await cacheOutcome(environment, "lookup-unavailable-or-rejected; compiling fresh");
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
    env: { ...buildEnvironment, CARGO_PROFILE_RELEASE_DEBUG: "1", CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO: "packed" },
  }));
  if (cache) {
    try {
      const payload = await sealSignedNative({ ...cache, outputDirectory: resolve(repositoryRoot, "target", target.rustTarget, "release"),
        generateSymbols, capture });
      if (environment.GITHUB_OUTPUT) await appendFile(environment.GITHUB_OUTPUT,
        `native_artifact=${signedArtifactName(cache.identity, cache.producer)}\nnative_directory=${cache.directory}\n`);
      await cacheOutcome(environment, "sealed; native artifact ready for upload");
      console.log("Signed native cache: sealed fresh binaries and matching dSYMs");
      return payload;
    } catch (error) {
      // Cache storage/symbol preparation is optional. Keep the successful Cargo
      // build; ordinary telemetry generation remains the release symbol gate.
      console.log(`Signed native cache: save unavailable (${error.message}); using fresh Cargo output`);
      await cacheOutcome(environment, "seal-failed; no native artifact upload");
    }
  }
  return null;
}

export async function buildDesktopRelease({
  channelName = process.argv[2],
  environment = process.env,
  prepareLadybug = preparePinnedLadybugForPackaging,
  nativePreparationReceipt,
  preparedWindowsNativeReceipt,
  repositoryRoot = resolve(import.meta.dirname, "../.."),
  loadContract = loadDesktopReleaseContract,
  execute = run,
  buildNative = buildReleaseRustServers,
} = {}) {
  if (channelName !== "stable" && channelName !== "preview") {
    throw new Error("Usage: node desktop/release/build-release.mjs <stable|preview>");
  }
  const desktopRoot = resolve(repositoryRoot, "desktop");
  const distRoot = resolve(desktopRoot, "dist");
  const releaseEnvironment = {
    ...environment,
    RELAYER_DESKTOP_RELEASE: "1",
    RELAYER_DESKTOP_CHANNEL: channelName,
  };
  const contract = await loadContract({ environment: releaseEnvironment, desktopRoot });

  if (nativePreparationReceipt && preparedWindowsNativeReceipt) {
    throw new Error("Windows native preparation and consumption are separate stages.");
  }
  if (nativePreparationReceipt) {
    return prepareWindowsNativeInputs({ contract, environment: releaseEnvironment, prepareLadybug, repositoryRoot, receiptPath: nativePreparationReceipt, buildNative });
  }

  const nativeDebugArtifacts = await buildReleaseNativeInputs({
    contract,
    environment: releaseEnvironment,
    prepareLadybug,
    repositoryRoot,
    preparedWindowsNativeReceipt,
    buildNative,
  });
  await rm(distRoot, { recursive: true, force: true });
  const builderArguments = contract.platform === "darwin"
    ? ["--config", "desktop/packaging/electron-builder.mjs", "--mac", "dmg", "zip", `--${contract.architecture}`, "--publish", "never"]
    : ["--config", "desktop/packaging/electron-builder.mjs", "--win", "nsis", "--x64", "--publish", "never"];
  await execute(process.execPath, [resolve(repositoryRoot, "node_modules", "electron-builder", "out", "cli", "cli.js"), ...builderArguments], {
    cwd: repositoryRoot,
    env: releaseEnvironment,
  });
  const appPath = desktopReleaseAppPath({ distRoot, contract });
  if (contract.platform === "darwin") {
    await notarizeAndStapleDesktopDMGs({ distRoot, environment: releaseEnvironment });
    await finalizeDesktopUpdateArtifact({ appPath, contract, distRoot });
    await verifyMacOSApplication(appPath, {
      assessNotarization: true,
      expectedArchitecture: contract.architecture === "x64" ? "x86_64" : contract.architecture,
    });
    await verifyDesktopUpdateZip({ contract, distRoot });
  } else {
    await verifyWindowsRelease({ appOutDir: appPath, distRoot, contract });
  }
  await verifyPackagedDesktopContract({ appPath, contract });
  await prepareDesktopTelemetryArtifacts({
    contract,
    repositoryRoot,
    outputRoot: resolve(distRoot, "telemetry"),
    packagedApplication: appPath,
    nativeDebugArtifacts,
  });
  await writeDesktopReleaseEvidence({ distRoot, contract });
  return verifyDesktopReleaseEvidence({ distRoot, contract });
}

export async function prepareWindowsNativeInputs({ receiptPath, buildNative = buildReleaseRustServers, ...options }) {
  windowsNativeHandoffContext(options.contract, options.environment);
  await rm(receiptPath, { force: true });
  await buildNative(options);
  return writeWindowsNativeHandoff({ ...options, receiptPath });
}

export async function buildReleaseNativeInputs({ preparedWindowsNativeReceipt, buildNative = buildReleaseRustServers, ...options }) {
  if (preparedWindowsNativeReceipt) {
    return verifyWindowsNativeHandoff({ ...options, receiptPath: preparedWindowsNativeReceipt });
  }
  return buildNative(options);
}

export function parseDesktopReleaseArguments(arguments_) {
  const [channelName, stage, receiptPath, ...extra] = arguments_;
  if (extra.length || (stage && (!receiptPath || !["--prepare-windows-native", "--use-windows-native"].includes(stage)))) {
    throw new Error("Usage: build-release.mjs <stable|preview> [--prepare-windows-native|--use-windows-native <receipt>]");
  }
  return { channelName,
    nativePreparationReceipt: stage === "--prepare-windows-native" ? resolve(receiptPath) : undefined,
    preparedWindowsNativeReceipt: stage === "--use-windows-native" ? resolve(receiptPath) : undefined };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildDesktopRelease(parseDesktopReleaseArguments(process.argv.slice(2)));
  console.log(JSON.stringify({ ok: true, receipt: result.nativeReceipt ?? result.names.receipt }, null, 2));
}
