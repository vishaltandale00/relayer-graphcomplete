import { dirname, resolve } from "node:path";

export function managedCodexHelperDirectory(executable) {
  if (typeof executable !== "string" || executable.trim() === "") {
    throw new Error("Managed Codex executable is required.");
  }
  return resolve(dirname(executable), "..", "codex-path");
}

export function withManagedCodexPath(environment, executable, { platform = process.platform } = {}) {
  const result = { ...environment };
  const pathKeys = Object.keys(result).filter((key) => key.toLowerCase() === "path");
  const existing = pathKeys.map((key) => result[key]).find((value) => typeof value === "string") ?? "";
  for (const key of pathKeys) delete result[key];
  const delimiter = platform === "win32" ? ";" : ":";
  const helper = managedCodexHelperDirectory(executable);
  const entries = existing.split(delimiter).filter((entry) => entry !== "" && entry !== helper);
  result.PATH = [helper, ...entries].join(delimiter);
  return result;
}
