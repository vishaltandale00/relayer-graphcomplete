import { resolve } from "node:path";

export function desktopReleaseAppPath({ distRoot, contract } = {}) {
  if (!distRoot || !contract?.platform || !contract?.productName) {
    throw new Error("Desktop release app path requires a distribution root and release contract.");
  }
  if (contract.platform === "win32") {
    if (contract.architecture !== "x64") {
      throw new Error(`Unsupported Windows release architecture: ${contract.architecture}.`);
    }
    return resolve(distRoot, "win-unpacked");
  }
  if (contract.platform !== "darwin") {
    throw new Error(`Unsupported desktop release platform: ${contract.platform}.`);
  }
  const outputDirectory = contract.architecture === "x64"
    ? "mac"
    : contract.architecture === "arm64"
      ? "mac-arm64"
      : null;
  if (!outputDirectory) {
    throw new Error(`Unsupported macOS release architecture: ${contract.architecture}.`);
  }
  return resolve(distRoot, outputDirectory, `${contract.productName}.app`);
}
