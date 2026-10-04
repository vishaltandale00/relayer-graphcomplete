import { spawn } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { desktopTargetFromEnvironment } from "../shared/target.mjs";
import {
  preparePinnedLadybugForPackaging,
  requireLadybugDistributionLicenseReady,
  withPinnedLadybugPackagingEnvironment,
} from "./pinned-ladybug-build.mjs";

import { cachedBuild, installRuntime, packagingIdentity, packagingBuildEnvironment, timedStage, runtimeBinaryNames, validateRuntime } from "./build-cache.mjs";

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

export async function buildDevelopmentDesktop({
  environment = process.env,
  execute = run,
  repositoryRoot = resolve(import.meta.dirname, "../.."),
  dependencyRoot = repositoryRoot,
  prepareLadybug = preparePinnedLadybugForPackaging,
  identify = packagingIdentity,
  requireLicense = requireLadybugDistributionLicenseReady,
} = {}) {
  const target = desktopTargetFromEnvironment(environment);
  if (target.key === "macos-arm64") environment = packagingBuildEnvironment(environment);
  let cache;
  if (target.key === "macos-arm64" && environment.RELAYER_PACKAGING_CACHE !== "off") {
    try {
      const root = resolve(repositoryRoot, ".relayer", "packaging-cache-v1");
      cache = { root, ...await timedStage("cache identity", () => identify({ repositoryRoot, cacheRoot: root, target, environment }), environment) };
    } catch (error) { console.log(`Packaging cache unavailable: ${error.message}`); }
  }
  // Recheck licensing even when compilation is reused; cache receipts grant no authority.
  if (target.key === "macos-arm64" || target.key === "windows-x64") await requireLicense();
  const outputDirectory = resolve(repositoryRoot, "target", target.rustTarget, "release");
  const compile = async () => {
    // CI can omit all compilation preparation after a verified runtime hit. If
    // that entry disappears or becomes invalid before consumption, restore the
    // locked dependency closure before entering the offline native build.
    if (environment.RELAYER_PACKAGING_FETCH_ON_MISS === "1") {
      await timedStage("fallback Cargo fetch", () => execute("cargo", ["fetch", "--locked", "--target", target.rustTarget], { cwd: repositoryRoot, env: environment }), environment);
    }
    return withPinnedLadybugPackagingEnvironment({
    environment, target,
    prepareLadybug: (options) => prepareLadybug({ ...options, cache }),
  }, (buildEnvironment, cargoIntegrityArguments) => timedStage("Cargo release", () => execute("cargo", [
    "build", "--release",
    "-p", "relayer-app-server",
    "-p", "relayer-graph-server",
    "--target", target.rustTarget,
    ...cargoIntegrityArguments,
  ], { cwd: repositoryRoot, env: buildEnvironment }), environment));
  };
  if (cache) {
    const payload = await timedStage("release runtime cache verify/build", () => cachedBuild({
      cacheRoot: cache.root, kind: "runtime", identity: cache.runtime,
      build: async (destination) => {
        await compile();
        try {
          await mkdir(destination, { recursive: true });
          for (const name of runtimeBinaryNames) await cp(join(outputDirectory, name), join(destination, name));
        } catch { console.log("Packaging runtime cache write failed; using fresh Cargo output"); return false; }
      },
      validate: validateRuntime,
      fallback: async () => { await compile(); return null; },
    }), environment);
    if (payload) {
      try { await installRuntime(payload, outputDirectory); }
      catch { console.log("Packaging runtime cache installation failed; compiling fresh"); await compile(); }
    }
  } else await compile();
  const configuration = "desktop/packaging/electron-builder.mjs";
  const platform = target.platform === "darwin" ? "--mac" : "--win";
  await timedStage("Electron assembly and afterPack", () => execute(process.execPath, [
    resolve(dependencyRoot, "node_modules", "electron-builder", "out", "cli", "cli.js"),
    "--config", configuration,
    "--dir",
    platform,
    `--${target.architecture}`,
  ], { cwd: repositoryRoot, env: environment }), environment);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--eval")) throw new Error("Eval runs from the checkout with npm run eval-app:dev.");
  await buildDevelopmentDesktop();
}
