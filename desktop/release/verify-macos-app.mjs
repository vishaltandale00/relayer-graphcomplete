import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { verifyBundledAppServer } from "../packaging/verify-bundled-app-server.mjs";
import { DESKTOP_RELEASE } from "./contract.mjs";
import { desktopTargetFromEnvironment } from "../shared/target.mjs";

const execFileAsync = promisify(execFile);

export function macOSNativeRuntimeExecutables(appPath, expectedArchitecture) {
  const target = expectedArchitecture === "x86_64"
    ? { packageName: "codex-darwin-x64", vendor: "x86_64-apple-darwin" }
    : expectedArchitecture === "arm64"
      ? { packageName: "codex-darwin-arm64", vendor: "aarch64-apple-darwin" }
      : null;
  if (!target) throw new Error(`Unsupported macOS release architecture: ${expectedArchitecture}.`);
  const vendorRoot = join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "@openai",
    target.packageName,
    "vendor",
    target.vendor,
  );
  return [
    join(vendorRoot, "bin", "codex"),
    join(vendorRoot, "bin", "codex-code-mode-host"),
    join(vendorRoot, "codex-path", "rg"),
    join(vendorRoot, "codex-resources", "zsh", "bin", "zsh"),
  ];
}

export async function verifyMacOSApplication(
  appPath,
  {
    assessNotarization = false,
    execute = execFileAsync,
    expectedTeamId = DESKTOP_RELEASE.appleTeamId,
    expectedArchitecture = process.arch === "x64" ? "x86_64" : process.arch,
  } = {},
) {
  await access(appPath);
  await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const signature = await execute("/usr/bin/codesign", ["--display", "--verbose=4", appPath]);
  const signatureDetails = `${signature.stdout || ""}\n${signature.stderr || ""}`;
  if (!/^Authority=Developer ID Application:/m.test(signatureDetails)) {
    throw new Error("Relayer.app is not signed by a Developer ID Application certificate.");
  }
  if (!signatureDetails.includes(`TeamIdentifier=${expectedTeamId}`)) {
    throw new Error(`Relayer.app is not signed by Apple team ${expectedTeamId}.`);
  }

  const plist = join(appPath, "Contents", "Info.plist");
  const readPlistValue = async (key) => {
    const result = await execute("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]);
    return String(result.stdout || "").trim();
  };
  const [bundleId, productName, minimumSystemVersion] = await Promise.all([
    readPlistValue("CFBundleIdentifier"),
    readPlistValue("CFBundleName"),
    readPlistValue("LSMinimumSystemVersion"),
  ]);
  if (bundleId !== DESKTOP_RELEASE.productionAppId || productName !== DESKTOP_RELEASE.productName) {
    throw new Error("Signed Relayer.app identity does not match the production release contract.");
  }
  if (minimumSystemVersion !== DESKTOP_RELEASE.minimumMacOSVersion) {
    throw new Error(`Signed Relayer.app must require macOS ${DESKTOP_RELEASE.minimumMacOSVersion}.`);
  }

  const executable = join(appPath, "Contents", "MacOS", DESKTOP_RELEASE.productName);
  const architectures = await execute("/usr/bin/lipo", ["-archs", executable]);
  if (String(architectures.stdout || "").trim() !== expectedArchitecture) {
    throw new Error(`Signed Relayer.app must contain only ${expectedArchitecture} executable code.`);
  }
  for (const nativeRuntimeExecutable of macOSNativeRuntimeExecutables(appPath, expectedArchitecture)) {
    await access(nativeRuntimeExecutable);
    const nativeArchitectures = await execute("/usr/bin/lipo", ["-archs", nativeRuntimeExecutable]);
    if (String(nativeArchitectures.stdout || "").trim() !== expectedArchitecture) {
      throw new Error(
        `Bundled native runtime ${nativeRuntimeExecutable} must contain only ${expectedArchitecture} executable code.`,
      );
    }
  }
  await verifyBundledAppServer(appPath, {
    execute,
    expectedArchitecture,
  });

  if (assessNotarization) {
    await execute("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
    await execute("/usr/bin/xcrun", ["stapler", "validate", appPath]);
  }
  return { appPath, bundleId, productName, minimumSystemVersion, expectedTeamId };
}

export default async function verifyElectronBuilderMacOSApplication(context) {
  if (process.env.RELAYER_DESKTOP_RELEASE !== "1") {
    throw new Error("macOS release signature verification requires explicit release mode.");
  }
  const productFilename = String(context?.packager?.appInfo?.productFilename || "").trim();
  const appOutDir = String(context?.appOutDir || "").trim();
  if (!productFilename || !appOutDir) {
    throw new Error("electron-builder afterSign context is missing the signed app path.");
  }
  const target = desktopTargetFromEnvironment(process.env);
  const expectedArchitecture = target.architecture === "x64" ? "x86_64" : target.architecture;
  return verifyMacOSApplication(join(appOutDir, `${productFilename}.app`), { expectedArchitecture });
}
