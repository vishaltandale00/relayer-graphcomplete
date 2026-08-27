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
  it("generates an ASAR containing every active adapter and no test provider fixtures", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-provider-package-"));
    temporaryDirectories.push(root);
    const source = join(root, "desktop-source");
    const stage = join(root, "app-stage");
    const archive = join(root, "app.asar");
    const desktopRoot = resolve("desktop");
    const generatedRoots = new Set(["dist", "eval-dist", "eval-main", "eval-renderer"]);
    await cp(desktopRoot, source, {
      recursive: true,
      filter: (path) => !generatedRoots.has(relative(desktopRoot, path).split(/[\\/]/u)[0]),
    });

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
  });
});
