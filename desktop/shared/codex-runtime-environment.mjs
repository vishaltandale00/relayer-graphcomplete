import { dirname, resolve } from "node:path";

export function managedCodexHelperDirectory(executable) {
  if (typeof executable !== "string" || executable.trim() === "") {
    throw new Error("Managed Codex executable is required.");
  }
  return resolve(dirname(executable), "..", "codex-path");
}

export function withConventionalPathKey(environment, { platform = process.platform } = {}) {
  const result = { ...environment };
  const pathKeys = Object.keys(result).filter((key) => key.toLowerCase() === "path");
  const conventionalKey = platform === "win32" ? "Path" : "PATH";
  const existing = typeof result[conventionalKey] === "string"
    ? result[conventionalKey]
    : pathKeys.map((key) => result[key]).find((value) => typeof value === "string");
  for (const key of pathKeys) delete result[key];
  if (typeof existing === "string") result[conventionalKey] = existing;
  return result;
}

export function withManagedCodexPath(environment, executable, { platform = process.platform } = {}) {
  const result = withConventionalPathKey(environment, { platform });
  const pathKey = platform === "win32" ? "Path" : "PATH";
  const existing = result[pathKey] ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const helper = managedCodexHelperDirectory(executable);
  const entries = existing.split(delimiter).filter((entry) => entry !== "" && entry !== helper);
  result[pathKey] = [helper, ...entries].join(delimiter);
  return result;
}
