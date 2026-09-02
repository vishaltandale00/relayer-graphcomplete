import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  CODEX_BROWSER_MCP_ENTRY,
  CODEX_BROWSER_MCP_PACKAGE,
  CODEX_BROWSER_MCP_VERSION,
  inspectCodexBrowserMcpRuntime,
} from "../desktop/main/services/codex-browser-mcp-runtime.mjs";
import { createDesktopBuilderConfig } from "../desktop/packaging/electron-builder.mjs";
import { resolveDesktopReleaseContract } from "../desktop/release/contract.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function runtimeFixture(version = CODEX_BROWSER_MCP_VERSION) {
  const root = await mkdtemp(join(tmpdir(), "relayer-codex-browser-"));
  temporaryDirectories.push(root);
  const executable = join(root, "Relayer");
  const packageRoot = join(root, "node_modules", CODEX_BROWSER_MCP_PACKAGE);
  const script = join(packageRoot, CODEX_BROWSER_MCP_ENTRY);
  await mkdir(dirname(script), { recursive: true });
  await Promise.all([
    writeFile(executable, "electron fixture\n"),
    writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: CODEX_BROWSER_MCP_PACKAGE, version })}\n`),
    writeFile(script, "#!/usr/bin/env node\n"),
  ]);
  return { executable, packageRoot, script };
}

describe("Codex browser MCP runtime", () => {
  it("accepts only the exact shipped helper and pins it through every desktop package", async () => {
    const fixture = await runtimeFixture();

    await expect(inspectCodexBrowserMcpRuntime(fixture), "exact shipped package accepted").resolves.toEqual({
      available: true,
      executable: fixture.executable,
      script: fixture.script,
      connectionArgs: [
        "--browserUrl",
        "http://127.0.0.1:9222",
        "--no-usage-statistics",
        "--no-performance-crux",
      ],
    });

    const drifted = await runtimeFixture("1.8.1");
    await expect(inspectCodexBrowserMcpRuntime(drifted), "version drift reported Codex-local").resolves.toMatchObject({
      available: false,
      code: "codex_browser_mcp_version_mismatch",
      message: expect.stringContaining(`${CODEX_BROWSER_MCP_PACKAGE}@${CODEX_BROWSER_MCP_VERSION}`),
      diagnostics: { actualVersion: "1.8.1" },
    });

    const missing = await runtimeFixture();
    await rm(missing.script);
    await expect(inspectCodexBrowserMcpRuntime(missing), "missing helper reported Codex-local").resolves.toMatchObject({
      available: false,
      code: "codex_browser_mcp_missing",
      diagnostics: { causeCode: "ENOENT" },
    });

    const corrupt = await runtimeFixture();
    await writeFile(join(corrupt.packageRoot, "package.json"), "not json\n");
    await expect(inspectCodexBrowserMcpRuntime(corrupt), "corrupt manifest reported Codex-local").resolves.toMatchObject({
      available: false,
      code: "codex_browser_mcp_invalid_manifest",
    });

    const previousTarget = process.env.RELAYER_DESKTOP_TARGET;
    let evalBuilderConfig;
    try {
      process.env.RELAYER_DESKTOP_TARGET = "macos-arm64";
      evalBuilderConfig = await import("../desktop/packaging/eval-electron-builder.mjs").then(
        ({ default: config }) => config,
      );
    } finally {
      if (previousTarget === undefined) {
        delete process.env.RELAYER_DESKTOP_TARGET;
      } else {
        process.env.RELAYER_DESKTOP_TARGET = previousTarget;
      }
    }
    const desktopManifest = JSON.parse(await readFile(new URL("../desktop/package.json", import.meta.url), "utf8"));
    const contract = resolveDesktopReleaseContract({
      environment: { RELAYER_DESKTOP_TARGET: "macos-arm64" },
      version: "0.2.16",
    });
    const productConfig = createDesktopBuilderConfig(contract, { argv: ["--dir"] });

    expect(desktopManifest.dependencies[CODEX_BROWSER_MCP_PACKAGE], "helper pinned in the desktop manifest").toBe(CODEX_BROWSER_MCP_VERSION);
    expect(productConfig.asarUnpack, "helper unpacked in the product package").toEqual(["node_modules/chrome-devtools-mcp/**/*"]);
    expect(evalBuilderConfig.asarUnpack, "helper unpacked in the Eval package").toEqual(["node_modules/chrome-devtools-mcp/**/*"]);
  });
});
