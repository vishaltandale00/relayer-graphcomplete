import { join } from "node:path";

const TARGETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    key: "macos-arm64",
    platform: "darwin",
    distributionPlatform: "macos",
    architecture: "arm64",
    rustTarget: "aarch64-apple-darwin",
    codexPackage: "codex-darwin-arm64",
    codexVendor: "aarch64-apple-darwin",
    format: "mac",
  }),
  "darwin-x64": Object.freeze({
    key: "macos-x64",
    platform: "darwin",
    distributionPlatform: "macos",
    architecture: "x64",
    rustTarget: "x86_64-apple-darwin",
    codexPackage: "codex-darwin-x64",
    codexVendor: "x86_64-apple-darwin",
    format: "mac",
  }),
  "win32-x64": Object.freeze({
    key: "windows-x64",
    platform: "win32",
    distributionPlatform: "windows",
    architecture: "x64",
    rustTarget: "x86_64-pc-windows-msvc",
    codexPackage: "codex-win32-x64",
    codexVendor: "x86_64-pc-windows-msvc",
    format: "win",
  }),
});

const TARGETS_BY_KEY = Object.freeze(Object.fromEntries(
  Object.values(TARGETS).map((target) => [target.key, target]),
));

export function desktopTarget({ platform = process.platform, architecture = process.arch } = {}) {
  const key = `${platform}-${architecture}`;
  const target = TARGETS[key];
  if (!target) throw new Error(`Unsupported Relayer Desktop target: ${key}.`);
  return target;
}

export function desktopTargetByKey(key) {
  const target = TARGETS_BY_KEY[String(key || "").trim()];
  if (!target) throw new Error(`Unsupported Relayer Desktop release target: ${key || "(empty)"}.`);
  return target;
}

export function desktopTargetFromEnvironment(environment = process.env) {
  const key = String(environment.RELAYER_DESKTOP_TARGET || "").trim();
  if (key) return desktopTargetByKey(key);
  return desktopTarget({
    platform: environment.RELAYER_DESKTOP_TARGET_PLATFORM || process.platform,
    architecture: environment.RELAYER_DESKTOP_TARGET_ARCH || process.arch,
  });
}

export function codexBinaryPath({ resourcesPath, repositoryRoot, packaged, ...targetOptions } = {}) {
  const target = desktopTarget(targetOptions);
  const root = packaged
    ? join(resourcesPath, "app.asar.unpacked", "node_modules", "@openai", target.codexPackage)
    : join(repositoryRoot, "node_modules", "@openai", target.codexPackage);
  return join(root, "vendor", target.codexVendor, "bin", target.platform === "win32" ? "codex.exe" : "codex");
}

export function targetForElectronBuilder({ platform = process.platform, architecture = process.arch } = {}) {
  const target = desktopTarget({ platform, architecture });
  return { platform: target.platform, arch: target.architecture, format: target.format };
}

export function nativeBinaryName(name, { platform = process.platform } = {}) {
  return `${name}${platform === "win32" ? ".exe" : ""}`;
}
