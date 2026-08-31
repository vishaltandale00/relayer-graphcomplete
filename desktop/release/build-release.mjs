import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
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
}) {
  const target = { key: contract.targetKey, rustTarget: contract.rustTarget };
  if (target.key !== "macos-arm64") {
    throw new Error(`Ladybug release packaging is not qualified for ${target.key}.`);
  }
  await verifyLadybugDistributionLicense();
  return withPinnedLadybugPackagingEnvironment({ environment, target, prepareLadybug }, async (
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
}

export async function buildDesktopRelease({
  channelName = process.argv[2],
  environment = process.env,
  prepareLadybug = preparePinnedLadybugForPackaging,
} = {}) {
  if (channelName !== "stable" && channelName !== "preview") {
    throw new Error("Usage: node desktop/release/build-release.mjs <stable|preview>");
  }
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const desktopRoot = resolve(repositoryRoot, "desktop");
  const distRoot = resolve(desktopRoot, "dist");
  const releaseEnvironment = {
    ...environment,
    RELAYER_DESKTOP_RELEASE: "1",
    RELAYER_DESKTOP_CHANNEL: channelName,
  };
  const contract = await loadDesktopReleaseContract({ environment: releaseEnvironment, desktopRoot });

  await buildReleaseRustServers({
    contract,
    environment: releaseEnvironment,
    prepareLadybug,
    repositoryRoot,
  });
  await rm(distRoot, { recursive: true, force: true });
  const builderArguments = contract.platform === "darwin"
    ? ["--config", "desktop/packaging/electron-builder.mjs", "--mac", "dmg", "zip", `--${contract.architecture}`, "--publish", "never"]
    : ["--config", "desktop/packaging/electron-builder.mjs", "--win", "nsis", "--x64", "--publish", "never"];
  await run(resolve(repositoryRoot, "node_modules", ".bin", "electron-builder"), builderArguments, {
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
  });
  await writeDesktopReleaseEvidence({ distRoot, contract });
  return verifyDesktopReleaseEvidence({ distRoot, contract });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildDesktopRelease();
  console.log(JSON.stringify({ ok: true, receipt: result.names.receipt }, null, 2));
}
