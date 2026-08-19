import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { desktopTargetFromEnvironment } from "../shared/target.mjs";

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

export async function buildDevelopmentDesktop({ evalApplication = false, environment = process.env } = {}) {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const target = desktopTargetFromEnvironment(environment);
  await run("cargo", [
    "build", "--release",
    "-p", "relayer-app-server",
    "-p", "relayer-graph-server",
    "--target", target.rustTarget,
  ], { cwd: repositoryRoot, env: environment });
  const configuration = evalApplication
    ? "desktop/packaging/eval-electron-builder.mjs"
    : "desktop/packaging/electron-builder.mjs";
  const platform = target.platform === "darwin" ? "--mac" : "--win";
  await run(process.execPath, [
    resolve(repositoryRoot, "node_modules", "electron-builder", "out", "cli", "cli.js"),
    "--config", configuration,
    "--dir",
    platform,
    `--${target.architecture}`,
  ], { cwd: repositoryRoot, env: environment });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDevelopmentDesktop({ evalApplication: process.argv.includes("--eval") });
}
