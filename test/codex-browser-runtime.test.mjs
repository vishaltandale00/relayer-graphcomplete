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
import evalBuilderConfig from "../desktop/packaging/eval-electron-builder.mjs";
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
  it("accepts only the exact shipped package and returns absolute Electron-as-Node launch data", async () => {
    const fixture = await runtimeFixture();

    await expect(inspectCodexBrowserMcpRuntime(fixture)).resolves.toEqual({
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
  });

  it("reports a Codex-local unavailable runtime when the packaged helper version drifts", async () => {
    const fixture = await runtimeFixture("1.8.1");

    await expect(inspectCodexBrowserMcpRuntime(fixture)).resolves.toMatchObject({
      available: false,
      code: "codex_browser_mcp_version_mismatch",
      message: expect.stringContaining(`${CODEX_BROWSER_MCP_PACKAGE}@${CODEX_BROWSER_MCP_VERSION}`),
      diagnostics: { actualVersion: "1.8.1" },
    });
  });

  it("reports a Codex-local unavailable runtime when the helper is missing", async () => {
    const fixture = await runtimeFixture();
    await rm(fixture.script);

    await expect(inspectCodexBrowserMcpRuntime(fixture)).resolves.toMatchObject({
      available: false,
      code: "codex_browser_mcp_missing",
      diagnostics: { causeCode: "ENOENT" },
    });
  });

  it("reports a Codex-local unavailable runtime when the manifest is corrupt", async () => {
    const fixture = await runtimeFixture();
    await writeFile(join(fixture.packageRoot, "package.json"), "not json\n");

    await expect(inspectCodexBrowserMcpRuntime(fixture)).resolves.toMatchObject({
      available: false,
      code: "codex_browser_mcp_invalid_manifest",
    });
  });

  it("pins and unpacks the helper in product and Eval desktop packages", async () => {
    const desktopManifest = JSON.parse(await readFile(new URL("../desktop/package.json", import.meta.url), "utf8"));
    const contract = resolveDesktopReleaseContract({
      environment: { RELAYER_DESKTOP_TARGET: "macos-arm64" },
      version: "0.2.16",
    });
    const productConfig = createDesktopBuilderConfig(contract, { argv: ["--dir"] });

    expect(desktopManifest.dependencies[CODEX_BROWSER_MCP_PACKAGE]).toBe(CODEX_BROWSER_MCP_VERSION);
    expect(productConfig.asarUnpack).toEqual(["node_modules/chrome-devtools-mcp/**/*"]);
    expect(evalBuilderConfig.asarUnpack).toEqual(["node_modules/chrome-devtools-mcp/**/*"]);
  });
});
