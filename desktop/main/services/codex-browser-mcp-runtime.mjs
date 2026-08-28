import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const CODEX_BROWSER_MCP_PACKAGE = "chrome-devtools-mcp";
export const CODEX_BROWSER_MCP_VERSION = "1.8.0";
export const CODEX_BROWSER_MCP_ENTRY = join("build", "src", "bin", "chrome-devtools-mcp.js");

const CONNECTION_ARGS = Object.freeze([
  "--browserUrl",
  "http://127.0.0.1:9222",
  "--no-usage-statistics",
  "--no-performance-crux",
]);

export async function inspectCodexBrowserMcpRuntime({ executable, packageRoot }) {
  if (typeof executable !== "string"
    || typeof packageRoot !== "string"
    || !isAbsolute(executable)
    || !isAbsolute(packageRoot)) {
    return unavailableRuntime(
      "codex_browser_mcp_invalid_paths",
      "Codex browser support is unavailable because its shipped runtime paths are invalid.",
      { executable, packageRoot },
    );
  }
  const manifestPath = join(packageRoot, "package.json");
  const script = join(packageRoot, CODEX_BROWSER_MCP_ENTRY);
  let manifestBytes;
  let executableStat;
  let scriptStat;
  try {
    [manifestBytes, executableStat, scriptStat] = await Promise.all([
      readFile(manifestPath, "utf8"),
      stat(executable),
      stat(script),
    ]);
  } catch (error) {
    return unavailableRuntime(
      "codex_browser_mcp_missing",
      "Codex browser support is unavailable because its shipped helper is missing or unreadable.",
      runtimeDiagnostics({ executable, packageRoot, error }),
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes);
  } catch (error) {
    return unavailableRuntime(
      "codex_browser_mcp_invalid_manifest",
      "Codex browser support is unavailable because its shipped helper manifest is invalid.",
      runtimeDiagnostics({ executable, packageRoot, error }),
    );
  }
  if (manifest?.name !== CODEX_BROWSER_MCP_PACKAGE || manifest?.version !== CODEX_BROWSER_MCP_VERSION) {
    return unavailableRuntime(
      "codex_browser_mcp_version_mismatch",
      `Codex browser support requires ${CODEX_BROWSER_MCP_PACKAGE}@${CODEX_BROWSER_MCP_VERSION}.`,
      { executable, packageRoot, actualName: manifest?.name ?? null, actualVersion: manifest?.version ?? null },
    );
  }
  if (!executableStat.isFile() || !scriptStat.isFile()) {
    return unavailableRuntime(
      "codex_browser_mcp_invalid_files",
      "Codex browser support is unavailable because its shipped runtime files are invalid.",
      { executable, packageRoot },
    );
  }
  return Object.freeze({
    available: true,
    executable,
    script,
    connectionArgs: CONNECTION_ARGS,
  });
}

function unavailableRuntime(code, message, diagnostics) {
  return Object.freeze({
    available: false,
    code,
    message,
    diagnostics: Object.freeze(diagnostics),
  });
}

function runtimeDiagnostics({ executable, packageRoot, error }) {
  return {
    executable,
    packageRoot,
    causeCode: typeof error?.code === "string" ? error.code : null,
  };
}
