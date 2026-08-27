import { createPackage, listPackage } from "@electron/asar";
import { FileMatcher } from "app-builder-lib/out/fileMatcher.js";
import { cp, copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDesktopBuilderConfig } from "../desktop/packaging/electron-builder.mjs";
import {
  ACTIVE_PROVIDER_ADAPTER_IDS,
  PACKAGED_PROVIDER_MODULES,
} from "../desktop/main/providers/provider-adapter-registry.mjs";
import { resolveDesktopReleaseContract } from "../desktop/release/contract.mjs";
import { assertNoBundledHarnessRuntimes } from "../desktop/release/verify-packaged-contract.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { force: true, recursive: true })
  )));
});

async function walkFiles(root, visit, directory = root) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(root, visit, file);
    else if (entry.isFile()) await visit(file);
  }
}

async function buildConfiguredAsar({ source, stage, archive, patterns }) {
  const matcher = new FileMatcher(source, stage, (value) => value, patterns);
  const include = matcher.createFilter();
  await walkFiles(source, async (file) => {
    if (!include(file, await stat(file))) return;
    const destination = join(stage, relative(source, file));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file, destination);
  });
  await createPackage(stage, archive);
  return new Set(listPackage(archive).map((entry) => entry.replace(/^\//u, "")));
}

describe("provider adapter packaging", () => {
  it.each([
    "node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex",
    "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
    "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
  ])("rejects a packaged native harness runtime: %s", (entry) => {
    expect(() => assertNoBundledHarnessRuntimes(new Set([entry]))).toThrow(/must not package a native harness runtime/);
  });

  it("allows the JavaScript SDK and installer dependencies without native harness artifacts", () => {
    expect(() => assertNoBundledHarnessRuntimes(new Set([
      "node_modules/@openai/codex-sdk/dist/index.js",
      "node_modules/semver/index.js",
      "node_modules/tar/dist/commonjs/index.js",
    ]))).not.toThrow();
  });

  it("generates an ASAR containing every active adapter and no test provider fixtures", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-package-"));
    temporaryDirectories.push(root);
    const source = join(root, "desktop-source");
    const stage = join(root, "app-stage");
    const archive = join(root, "app.asar");
    await cp(resolve("desktop"), source, { recursive: true });

    await mkdir(join(source, "main/providers/implementations/__fixtures__"), { recursive: true });
    await writeFile(
      join(source, "main/providers/implementations/__fixtures__/fake-provider.mjs"),
      "throw new Error('test fixture must not ship');\n",
    );
    await writeFile(
      join(source, "main/providers/implementations/leaked-provider.test.mjs"),
      "throw new Error('test module must not ship');\n",
    );
    await writeFile(
      join(source, "main/providers/implementations/future-provider.mjs"),
      "export const futureProviderDescriptor = {};\n",
    );

    const contract = resolveDesktopReleaseContract({
      environment: { RELAYER_DESKTOP_TARGET: "macos-arm64" },
      version: "0.2.12",
    });
    const config = createDesktopBuilderConfig(contract, { argv: ["--dir"] });
    const packaged = await buildConfiguredAsar({ source, stage, archive, patterns: config.files });

    expect(ACTIVE_PROVIDER_ADAPTER_IDS).toEqual([
      "codex-subscription",
      "claude-subscription",
      "openai-api",
      "anthropic-api",
      "openrouter",
      "vercel-ai-router",
    ]);
    for (const required of [
      "package.json",
      "main/index.mjs",
      "main/providers/provider-adapter-registry.mjs",
      "main/providers/provider-adapter-contract.mjs",
      ...PACKAGED_PROVIDER_MODULES.map((modulePath) => `main/${modulePath}`),
    ]) expect(packaged.has(required), required).toBe(true);
    expect([...packaged]).not.toContain("main/providers/implementations/__fixtures__/fake-provider.mjs");
    expect([...packaged]).not.toContain("main/providers/implementations/leaked-provider.test.mjs");
    expect([...packaged]).not.toContain("main/providers/implementations/future-provider.mjs");
    expect(new Set([...packaged].filter((entry) => entry.startsWith("main/providers/implementations/"))))
      .toEqual(new Set(PACKAGED_PROVIDER_MODULES.map((modulePath) => `main/${modulePath}`)));
    expect([...packaged].some((entry) => entry.startsWith("packaging/"))).toBe(false);
    expect([...packaged].some((entry) => entry.startsWith("release/"))).toBe(false);
    expect([...packaged].some((entry) => entry.startsWith("renderer/"))).toBe(false);
    expect([...packaged].some((entry) => (
      entry === "node_modules/@openai/codex/package.json" ||
      entry.startsWith("node_modules/@openai/codex/") ||
      /^node_modules\/@openai\/codex-(?:darwin|linux|win32)-/u.test(entry)
    ))).toBe(false);
    expect([...packaged].some((entry) => entry.startsWith("node_modules/@anthropic-ai/claude-agent-sdk-"))).toBe(false);
  });
});
