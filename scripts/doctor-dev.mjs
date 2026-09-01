import { execFileSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_RUST_TOOLCHAIN = "1.88.0";
export const MINIMUM_NODE_VERSION = "22.8.0";
export const MINIMUM_CMAKE_VERSION = "3.15.0";
export const ADVISORY_FREE_BYTES = 10n * 1024n * 1024n * 1024n;
const VISUAL_STUDIO_GENERATOR = /Visual Studio \d+(?: \d{4})?/u;

function versionParts(value) {
  const match = String(value ?? "").match(/(?:^|\s|v)(\d+)\.(\d+)(?:\.(\d+))?/u);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function readableBytes(bytes) {
  return `${(Number(bytes) / (1024 ** 3)).toFixed(1)} GiB`;
}

function check(name, passed, detail, remediation, advisory = false) {
  return { name, passed, detail, remediation, advisory };
}

export function evaluateDeveloperPrerequisites({
  platform,
  nodeVersion,
  rustcVersion,
  cargoVersion,
  cmakeVersion,
  xcodeSelectPath,
  clangCompilerPath,
  buildToolVersion,
  cmakeGenerators,
  diskReports = [],
}) {
  const checks = [];
  const nodeParts = versionParts(nodeVersion);
  checks.push(check(
    "Node.js",
    nodeParts !== null && compareVersions(nodeParts, versionParts(MINIMUM_NODE_VERSION)) >= 0,
    nodeVersion ? `found ${nodeVersion}; requires ${MINIMUM_NODE_VERSION} or newer` : "not found",
    "Install the repository Node version before running npm scripts.",
  ));

  const rustToolchainMatches = new RegExp(`^rustc ${REQUIRED_RUST_TOOLCHAIN.replaceAll(".", "\\.")}(?: \\(|$)`, "u").test(rustcVersion ?? "");
  checks.push(check(
    "Rust toolchain",
    rustToolchainMatches,
    rustcVersion ? `found ${rustcVersion}; requires rustc ${REQUIRED_RUST_TOOLCHAIN}` : "rustc is not available",
    "Install the pinned toolchain with rustup; rust-toolchain.toml is the repository authority.",
  ));

  const cargoMatches = new RegExp(`^cargo ${REQUIRED_RUST_TOOLCHAIN.replaceAll(".", "\\.")}(?: \\(|$)`, "u").test(cargoVersion ?? "");
  checks.push(check(
    "Cargo",
    cargoMatches,
    cargoVersion ? `found ${cargoVersion}; requires cargo ${REQUIRED_RUST_TOOLCHAIN}` : "cargo is not available",
    "Use the Rust toolchain selected by rust-toolchain.toml.",
  ));

  const cmakeParts = versionParts(cmakeVersion);
  checks.push(check(
    "CMake",
    cmakeParts !== null && compareVersions(cmakeParts, versionParts(MINIMUM_CMAKE_VERSION)) >= 0,
    cmakeVersion
      ? `found ${cmakeVersion}; requires ${MINIMUM_CMAKE_VERSION} or newer (4.4.3 is the known-good local version)`
      : "cmake is not available",
    "Install CMake and make it available on PATH.",
  ));

  if (platform === "darwin") {
    checks.push(check(
      "Xcode Command Line Tools",
      typeof xcodeSelectPath === "string" && xcodeSelectPath.trim() !== "",
      xcodeSelectPath ? `selected at ${xcodeSelectPath}` : "xcode-select has no active developer directory",
      "Install or select Xcode Command Line Tools with xcode-select --install or xcode-select --switch.",
    ));
    checks.push(check(
      "Apple C++ compiler",
      typeof clangCompilerPath === "string" && clangCompilerPath.trim() !== "",
      clangCompilerPath ? `found ${clangCompilerPath}` : "xcrun could not find clang++",
      "Install Xcode Command Line Tools or full Xcode and select the intended developer directory.",
    ));
  } else if (platform === "win32") {
    checks.push(check(
      "Windows CMake generator",
      (typeof buildToolVersion === "string" && buildToolVersion.trim() !== "")
        || VISUAL_STUDIO_GENERATOR.test(cmakeGenerators ?? ""),
      buildToolVersion
        ? `found Ninja ${buildToolVersion}`
        : VISUAL_STUDIO_GENERATOR.test(cmakeGenerators ?? "")
          ? "CMake advertises a Visual Studio generator"
          : "no Ninja or Visual Studio generator was found",
      "Install CMake with Ninja, or use a Visual Studio generator from a Developer PowerShell.",
    ));
    checks.push(check(
      "Windows C++ compiler",
      typeof clangCompilerPath === "string" && clangCompilerPath.trim() !== "",
      clangCompilerPath ? `found ${clangCompilerPath}` : "where cl or clang-cl did not find a compiler",
      "Install the Visual Studio Desktop development with C++ workload, or LLVM clang-cl, and use its Developer PowerShell.",
    ));
  } else {
    checks.push(check(
      "Unix native build tool",
      typeof buildToolVersion === "string" && buildToolVersion.trim() !== "",
      buildToolVersion ? "found make" : "make is not available",
      "Install make and a C++20 compiler from the host package manager.",
    ));
    checks.push(check(
      "C++ compiler",
      typeof clangCompilerPath === "string" && clangCompilerPath.trim() !== "",
      clangCompilerPath ? `found ${clangCompilerPath}` : "c++ is not available",
      "Install a C++20-capable compiler from the host package manager.",
    ));
  }

  for (const report of diskReports) {
    const freeBytes = typeof report.freeBytes === "bigint" ? report.freeBytes : BigInt(report.freeBytes ?? -1);
    checks.push(check(
      `Free space: ${report.path}`,
      true,
      `${readableBytes(freeBytes)} available; ${readableBytes(ADVISORY_FREE_BYTES)} is an advisory warning threshold for source Ladybug builds`,
      "Inspect this exact target and move CARGO_TARGET_DIR or free space before starting a large native build.",
      freeBytes < ADVISORY_FREE_BYTES,
    ));
  }

  return { ok: checks.every(({ passed }) => passed), checks };
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}

function existingPath(path) {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = resolve(candidate, "..");
    if (parent === candidate) return null;
    candidate = parent;
  }
  return candidate;
}

function freeBytes(path) {
  const existing = existingPath(path);
  if (existing === null) return null;
  const stats = statfsSync(existing);
  return BigInt(stats.bavail) * BigInt(stats.bsize);
}

function diskReports(repositoryRoot, environment) {
  const target = environment.CARGO_TARGET_DIR
    ? resolve(repositoryRoot, environment.CARGO_TARGET_DIR)
    : resolve(repositoryRoot, "target");
  const paths = [...new Set([repositoryRoot, target, environment.TMPDIR || tmpdir()])];
  return paths.flatMap((path) => {
    const bytes = freeBytes(path);
    return bytes === null ? [] : [{ path, freeBytes: bytes }];
  });
}

export function collectDeveloperPrerequisites({
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  platform = process.platform,
  environment = process.env,
} = {}) {
  const rustcVersion = commandOutput("rustc", ["--version"]);
  const cargoVersion = commandOutput("cargo", ["--version"]);
  const cmakeVersion = commandOutput("cmake", ["--version"]);
  const xcodeSelectPath = platform === "darwin" ? commandOutput("xcode-select", ["-p"]) : undefined;
  const clangCompilerPath = platform === "darwin"
    ? commandOutput("xcrun", ["--find", "clang++"])
    : platform === "win32"
      ? [commandOutput("where", ["cl"]), commandOutput("where", ["clang-cl"])]
        .filter(Boolean)
        .join("; ") || null
      : commandOutput("sh", ["-c", "command -v c++"]);
  const buildToolVersion = platform === "win32"
    ? commandOutput("ninja", ["--version"])
    : commandOutput("make", ["--version"]);
  const cmakeGenerators = platform === "win32" ? commandOutput("cmake", ["--help"]) : undefined;

  return evaluateDeveloperPrerequisites({
    platform,
    nodeVersion: process.versions.node,
    rustcVersion,
    cargoVersion,
    cmakeVersion: cmakeVersion?.split(/\r?\n/u, 1)[0],
    xcodeSelectPath,
    clangCompilerPath,
    buildToolVersion,
    cmakeGenerators,
    diskReports: diskReports(repositoryRoot, environment),
  });
}

export function printDeveloperPrerequisites(report, output = console) {
  output.log(`Developer prerequisites: ${report.ok ? "PASS" : "BLOCKED"}`);
  for (const item of report.checks) {
    const status = item.advisory ? "WARN" : item.passed ? "PASS" : "FAIL";
    output.log(`${status} ${item.name} — ${item.detail}`);
    if (item.advisory || !item.passed) output.log(`      ${item.remediation}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const report = collectDeveloperPrerequisites();
  printDeveloperPrerequisites(report);
  if (!report.ok) process.exitCode = 1;
}
