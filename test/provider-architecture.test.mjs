import { readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { init, parse } from "es-module-lexer";
import { describe, expect, it } from "vitest";
import { glob } from "node:fs/promises";

import {
  ACTIVE_PROVIDER_ADAPTER_MODULES,
  PROVIDER_ADAPTER_SUPPORT_MODULES,
} from "../desktop/main/providers/provider-adapter-registry.mjs";

const shippedJavaScriptExtensions = new Set([".cjs", ".js", ".mjs"]);

function importedSpecifiers(source) {
  const specifiers = parse(source)[0]
    .flatMap((entry) => typeof entry.n === "string" ? [entry.n] : []);
  for (const match of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function isInside(root, target) {
  const path = relative(root, target);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

function forbiddenImplementationImport(importer, specifier, implementationDirectory, supportModules) {
  if (!specifier.startsWith(".")) return false;
  const target = resolve(dirname(importer), specifier);
  if (!isInside(implementationDirectory, target)) return false;
  return !(supportModules.has(target) && isInside(implementationDirectory, importer));
}

describe("provider adapter architecture", () => {
  it("recognizes static, dynamic, and CommonJS imports of concrete adapters", async () => {
    await init;
    expect(importedSpecifiers(`
      import "./providers/implementations/openai-api.mjs";
      await import("./providers/implementations/anthropic-api.mjs");
      require("./providers/implementations/openrouter.mjs");
    `)).toEqual([
      "./providers/implementations/openai-api.mjs",
      "./providers/implementations/anthropic-api.mjs",
      "./providers/implementations/openrouter.mjs",
    ]);
  });

  it("allows only the authoritative registry to import concrete implementations", async () => {
    await init;
    const desktopRoot = resolve("desktop");
    const registry = resolve(desktopRoot, "main/providers/provider-adapter-registry.mjs");
    const implementationDirectory = resolve(desktopRoot, "main/providers/implementations");
    const concreteAdapters = new Set(Object.values(ACTIVE_PROVIDER_ADAPTER_MODULES).map((relative) => (
      resolve(desktopRoot, "main", relative)
    )));
    const supportModules = new Set(PROVIDER_ADAPTER_SUPPORT_MODULES.map((module) => (
      resolve(desktopRoot, "main", module)
    )));
    const implementationFiles = new Set();
    const violations = [];
    for await (const relative of glob("**/*", { cwd: desktopRoot })) {
      const file = resolve(desktopRoot, relative);
      if (isInside(implementationDirectory, file) && extname(file) === ".mjs") implementationFiles.add(file);
      if (!shippedJavaScriptExtensions.has(extname(file)) || file === registry) continue;
      const source = await readFile(file, "utf8");
      const importsProviderImplementation = importedSpecifiers(source).some((specifier) => (
        forbiddenImplementationImport(file, specifier, implementationDirectory, supportModules)
      ));
      const hidesImplementationImportFromTheParser = /(?:import|require)\s*\([^)]*providers\/implementations\//u.test(source)
        && !importedSpecifiers(source).some((specifier) => specifier.includes("providers/implementations/"));
      if (importsProviderImplementation || hidesImplementationImportFromTheParser) violations.push(relative);
    }
    expect(violations).toEqual([]);
    expect(implementationFiles).toEqual(new Set([
      ...concreteAdapters,
      ...[...supportModules].filter((file) => isInside(implementationDirectory, file)),
    ]));
    const productionComposition = await readFile(resolve(desktopRoot, "main/index.mjs"), "utf8");
    expect(productionComposition).not.toMatch(/definition\.adapterId\s*===/u);
  });

  it("rejects a direct import of an unregistered seventh provider implementation", () => {
    const implementationDirectory = resolve("desktop/main/providers/implementations");
    const importer = resolve("desktop/main/index.mjs");
    expect(forbiddenImplementationImport(
      importer,
      "./providers/implementations/future-provider.mjs",
      implementationDirectory,
      new Set(),
    )).toBe(true);
  });

  it("does not read the legacy Codex account after generic provider onboarding", async () => {
    const auth = await readFile(resolve("desktop/renderer/src/auth.js"), "utf8");
    expect(auth).not.toContain("desktop.account?.read?.()");
  });
});
