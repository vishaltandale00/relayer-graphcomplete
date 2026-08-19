import { execFile } from "node:child_process";
import { listPackage } from "@electron/asar";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { desktopTargetFromEnvironment } from "../shared/target.mjs";

const execFileAsync = promisify(execFile);

export async function verifyBundledAppServer(
  appPath,
  {
    execute = execFileAsync,
    expectedArchitecture = process.arch === "x64" ? "x86_64" : process.arch,
    listPackageEntries = listPackage,
  } = {},
) {
  const resourcesPath = join(appPath, "Contents", "Resources");
  const binaryPath = join(appPath, "Contents", "Resources", "bin", "relayer-app-server");
  const graphBinaryPath = join(appPath, "Contents", "Resources", "bin", "relayer-graph-server");
  const graphClientPath = join(appPath, "Contents", "Resources", "graph-client", "index.js");
  const markedPath = join(resourcesPath, "renderer", "vendor", "marked.umd.js");
  await Promise.all([access(binaryPath), access(graphBinaryPath), access(graphClientPath), access(markedPath)]);
  const packagedEntries = new Set(listPackageEntries(join(resourcesPath, "app.asar")).map((entry) => String(entry).replace(/^\//, "")));
  for (const entry of [
    "main/single-instance.mjs",
    "node_modules/@relayer/graph-client/dist/index.js",
    "node_modules/@relayer/harness-host/dist/index.js",
    "node_modules/@relayer/eval-runner/dist/index.js",
  ]) {
    if (!packagedEntries.has(entry)) throw new Error(`Bundled Relayer runtime is missing ${entry}.`);
  }
  let architectures;
  for (const [label, executable] of [["app server", binaryPath], ["graph server", graphBinaryPath]]) {
    const result = await execute("/usr/bin/lipo", ["-archs", executable]);
    architectures = String(result.stdout || "").trim();
    if (architectures !== expectedArchitecture) {
      throw new Error(
        `Bundled Relayer ${label} must contain only ${expectedArchitecture} executable code; found ${architectures || "unknown"}.`,
      );
    }
  }
  return { binaryPath, architecture: architectures };
}

export default async function verifyElectronBuilderBundledAppServer(context) {
  const productFilename = String(context?.packager?.appInfo?.productFilename || "").trim();
  const appOutDir = String(context?.appOutDir || "").trim();
  if (!productFilename || !appOutDir) {
    throw new Error("electron-builder afterPack context is missing the packaged app path.");
  }
  const target = desktopTargetFromEnvironment(process.env);
  const expectedArchitecture = target.architecture === "x64" ? "x86_64" : target.architecture;
  return verifyBundledAppServer(join(appOutDir, `${productFilename}.app`), { expectedArchitecture });
}
