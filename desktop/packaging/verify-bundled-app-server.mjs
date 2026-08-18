import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function verifyBundledAppServer(
  appPath,
  { execute = execFileAsync, expectedArchitecture = "arm64" } = {},
) {
  const binaryPath = join(appPath, "Contents", "Resources", "bin", "relayer-app-server");
  const graphBinaryPath = join(appPath, "Contents", "Resources", "bin", "relayer-graph-server");
  const graphClientPath = join(appPath, "Contents", "Resources", "graph-client", "index.js");
  await Promise.all([access(binaryPath), access(graphBinaryPath), access(graphClientPath)]);
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
  return verifyBundledAppServer(join(appOutDir, `${productFilename}.app`));
}
