import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createDesktopBuilderConfig } from "../desktop/packaging/electron-builder.mjs";
import {
  inspectPrimeAgentRuntime,
  validatePrimeAgentManifest,
} from "../desktop/main/services/prime-agent-runtime.mjs";
import {
  asarEntryPath,
  digestAsarDependencyClosure,
  verifyPackagedPrimeAgent,
} from "../desktop/packaging/verify-bundled-app-server.mjs";
import { PACKAGED_PROVIDER_MODULES } from "../desktop/main/providers/provider-adapter-registry.mjs";
import { primeRuntimeSourcePathIsPackaged } from "../desktop/shared/prime-runtime-integrity.mjs";
import { resolveDesktopReleaseContract } from "../desktop/release/contract.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const manifestPath = join(repositoryRoot, "vendor", "prime-agent", "manifest.json");
const execFileAsync = promisify(execFile);

async function packageFileEntries(root, relativeRoot, output = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = join(relativeRoot, entry.name).replaceAll("\\", "/");
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) await packageFileEntries(absolutePath, relativePath, output);
    else if (entry.isFile()) output.push(relativePath);
  }
  return output;
}

describe("Prime Agent packaged runtime", () => {
  it("keeps integrity-bound source assets byte-stable across host checkouts", async () => {
    const attributes = await readFile(join(repositoryRoot, ".gitattributes"), "utf8");
    expect(attributes.split(/\r?\n/)).toEqual(expect.arrayContaining([
      "harnesses/*.yaml text eol=lf",
      "python/relayer-graph/src/relayer_graph/**/*.py text eol=lf",
    ]));
    expect(asarEntryPath("/node_modules/@earendil-works/pi-agent-core/package.json", "darwin"))
      .toBe("node_modules/@earendil-works/pi-agent-core/package.json");
    expect(asarEntryPath("\\node_modules\\@earendil-works\\pi-agent-core\\package.json", "win32"))
      .toBe("node_modules\\@earendil-works\\pi-agent-core\\package.json");
  });

  it("pins reproducible content-addressed packages and lockfile resolutions", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const lockfile = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8"));
    const desktopManifest = JSON.parse(await readFile(join(repositoryRoot, "desktop", "package.json"), "utf8"));

    expect(manifest.source.commit).toBe("bfd41d7786a9177aed5f609f9db3fec2f308a326");
    expect(manifest.runtimeContract.modelScopeAccess).toBe("upfront-request-access@1");
    expect(manifest.packages).toHaveLength(4);
    for (const entry of manifest.packages) {
      const bytes = await readFile(join(repositoryRoot, "vendor", "prime-agent", entry.file));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
      const expectedResolution = `file:vendor/prime-agent/${entry.file}`;
      expect(lockfile.packages[`node_modules/${entry.name}`]).toMatchObject({
        version: entry.version,
        resolved: expectedResolution,
      });
      expect(desktopManifest.dependencies[entry.name]).toBe(`file:../vendor/prime-agent/${entry.file}`);
    }
    expect(JSON.stringify(lockfile)).not.toContain("/Users/");
    expect(JSON.stringify(lockfile)).not.toContain("prime-agent/packages/");
  });

  it("discovers the browser route through Prime's bundled Python skill semantics", async () => {
    const { loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent");
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
    const { skills } = loadSkillsFromDir({ dir: join(packageRoot, "skills"), source: "builtin" });
    const browser = skills.find(({ name }) => name === "browser");

    expect(browser).toMatchObject({
      name: "browser",
      kind: "python",
      python: { importName: "browser" },
    });
    for (const name of ["prime-agent-basic.yaml", "prime-agent-deep.yaml"]) {
      const configuration = await readFile(join(repositoryRoot, "harnesses", name), "utf8");
      expect(configuration).toContain("ask:\n    boundary: workspace-write@1");
      expect(configuration).toContain("auto:\n    boundary: workspace-write@1");
      expect(configuration).toContain("full: {}");
    }
  });

  it("admits only the exact runtime API, production configs, and Python client", async () => {
    await expect(inspectPrimeAgentRuntime({
      appPath: repositoryRoot,
      harnessDirectory: join(repositoryRoot, "harnesses"),
      manifestPath,
      pythonClientRoot: join(repositoryRoot, "python", "relayer-graph", "src"),
      platform: "darwin",
      architecture: "arm64",
    })).resolves.toMatchObject({
      available: true,
      sourceCommit: "bfd41d7786a9177aed5f609f9db3fec2f308a326",
      configurationNames: ["prime-agent-basic", "prime-agent-deep"],
    });

    const rejected = await inspectPrimeAgentRuntime({
      appPath: repositoryRoot,
      harnessDirectory: join(repositoryRoot, "harnesses"),
      manifestPath,
      pythonClientRoot: join(repositoryRoot, "python", "relayer-graph", "src"),
      platform: "darwin",
      architecture: "arm64",
      importPrimeAgent: async () => ({
        AGENT_RUN_MODEL_SCOPE_VERSION: 1,
        AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION: 1,
        AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION: 1,
      }),
    });
    expect(rejected).toMatchObject({
      available: false,
      code: "prime_agent_api_incompatible",
      message: "This Relayer build cannot use the packaged Prime Agent API. Update Relayer.",
      diagnostics: {
        sourceCommit: "bfd41d7786a9177aed5f609f9db3fec2f308a326",
        packages: expect.arrayContaining([{ name: "@earendil-works/pi-coding-agent", version: "0.8.1" }]),
      },
    });
    expect(JSON.stringify(rejected)).not.toContain("createAgentRunModelScope");
  });

  it("rejects manifests that duplicate configurations or weaken the runtime API", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const mutate of [
      (candidate) => { candidate.harnessConfigurations = ["prime-agent-basic.yaml", "prime-agent-basic.yaml"]; },
      (candidate) => { candidate.runtimeContract.constants = {}; },
      (candidate) => { candidate.runtimeContract.functions = []; },
      (candidate) => { candidate.runtimeContract.sessionFunctions = []; },
    ]) {
      const candidate = structuredClone(manifest);
      mutate(candidate);
      expect(() => validatePrimeAgentManifest(candidate)).toThrow();
    }
  });

  it("seals package resolution metadata and precedence-winning nested dependencies", () => {
    const root = "node_modules/@earendil-works/pi-coding-agent";
    const nested = `${root}/node_modules/nested-runtime`;
    const optional = "node_modules/optional-runtime";
    const peer = "node_modules/required-peer";
    const files = new Map([
      [`${root}/package.json`, Buffer.from(JSON.stringify({
        name: "root",
        main: "dist/index.js",
        dependencies: { "nested-runtime": "1.0.0" },
        optionalDependencies: { "optional-runtime": "1.0.0", "missing-optional": "1.0.0" },
        peerDependencies: { "required-peer": "1.0.0", "missing-optional-peer": "1.0.0" },
        peerDependenciesMeta: { "missing-optional-peer": { optional: true } },
      }))],
      [`${root}/dist/index.js`, Buffer.from("export const root = true;\n")],
      [`${nested}/package.json`, Buffer.from(JSON.stringify({ name: "nested-runtime", main: "index.js" }))],
      [`${nested}/index.js`, Buffer.from("module.exports = true;\n")],
      [`${optional}/package.json`, Buffer.from(JSON.stringify({ name: "optional-runtime", main: "index.js" }))],
      [`${optional}/index.js`, Buffer.from("module.exports = 'optional';\n")],
      [`${peer}/package.json`, Buffer.from(JSON.stringify({ name: "required-peer", main: "index.js" }))],
      [`${peer}/index.js`, Buffer.from("module.exports = 'peer';\n")],
    ]);
    let entries = new Set(files.keys());
    const digest = () => digestAsarDependencyClosure(
      "fixture.asar",
      [root],
      [...entries],
      entries,
      (_asar, path) => files.get(path),
    );
    const baseline = digest();
    files.set(`${root}/package.json`, Buffer.from(JSON.stringify({
      name: "root",
      main: "attacker.js",
      exports: "./attacker.js",
      dependencies: { "nested-runtime": "1.0.0" },
      optionalDependencies: { "optional-runtime": "1.0.0", "missing-optional": "1.0.0" },
      peerDependencies: { "required-peer": "1.0.0", "missing-optional-peer": "1.0.0" },
      peerDependenciesMeta: { "missing-optional-peer": { optional: true } },
    })));
    expect(digest()).not.toBe(baseline);
    files.set(`${root}/package.json`, Buffer.from(JSON.stringify({
      name: "root",
      main: "dist/index.js",
      dependencies: { "nested-runtime": "1.0.0" },
      optionalDependencies: { "optional-runtime": "1.0.0", "missing-optional": "1.0.0" },
      peerDependencies: { "required-peer": "1.0.0", "missing-optional-peer": "1.0.0" },
      peerDependenciesMeta: { "missing-optional-peer": { optional: true } },
    })));
    files.set(`${nested}/index.js`, Buffer.from("module.exports = 'mutated';\n"));
    expect(digest()).not.toBe(baseline);
    files.set(`${nested}/index.js`, Buffer.from("module.exports = true;\n"));
    files.set(`${optional}/index.js`, Buffer.from("module.exports = 'mutated optional';\n"));
    expect(digest()).not.toBe(baseline);
    files.set(`${optional}/index.js`, Buffer.from("module.exports = 'optional';\n"));
    files.set(`${peer}/index.js`, Buffer.from("module.exports = 'mutated peer';\n"));
    expect(digest()).not.toBe(baseline);
    entries = new Set([...entries].filter((path) => !path.startsWith(`${peer}/`)));
    expect(digest).toThrow("required-peer is unresolved");
  });

  it("uses locale-independent UTF-8 byte ordering for integrity digests", async () => {
    const integrityModule = new URL("../desktop/shared/prime-runtime-integrity.mjs", import.meta.url).href;
    const source = `
      import { digestFileEntries } from ${JSON.stringify(integrityModule)};
      const entries = [
        { path: "runtime/I.js", bytes: Buffer.from("upper") },
        { path: "runtime/ı.js", bytes: Buffer.from("dotless") },
        { path: "runtime/i.js", bytes: Buffer.from("lower") },
      ];
      process.stdout.write(digestFileEntries(entries));
    `;
    const run = async (locale) => (await execFileAsync(process.execPath, ["--input-type=module", "--eval", source], {
      env: { ...process.env, LC_ALL: locale, LANG: locale },
    })).stdout;
    expect(await run("tr_TR.UTF-8")).toBe(await run("en_US.UTF-8"));
  });

  it("compares packaged Prime source bytes and every declared support asset to reviewed content", async () => {
    const resources = await mkdtemp(join(tmpdir(), "relayer-prime-integrity-"));
    try {
      await mkdir(join(resources, "prime-agent"), { recursive: true });
      await mkdir(join(resources, "harnesses"), { recursive: true });
      await mkdir(join(resources, "python", "relayer-graph", "src"), { recursive: true });
      await cp(manifestPath, join(resources, "prime-agent", "manifest.json"));
      for (const name of ["prime-agent-basic.yaml", "prime-agent-deep.yaml"]) {
        await cp(join(repositoryRoot, "harnesses", name), join(resources, "harnesses", name));
      }
      await cp(
        join(repositoryRoot, "python", "relayer-graph", "src", "relayer_graph"),
        join(resources, "python", "relayer-graph", "src", "relayer_graph"),
        { recursive: true },
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const packagedEntries = new Set((await Promise.all(manifest.packages.map(async (entry) => {
        const prefix = `node_modules/${entry.name}/`;
        return (await packageFileEntries(
          join(repositoryRoot, "node_modules", ...entry.name.split("/")),
          `node_modules/${entry.name}`,
        )).filter((path) => path === `${prefix}package.json` || primeRuntimeSourcePathIsPackaged(path.slice(prefix.length)));
      }))).flat());
      for (const path of PACKAGED_PROVIDER_MODULES) packagedEntries.add(`main/${path}`);
      const extractPackageFile = (_asar, path) => readFileSync(join(repositoryRoot, path));
      await expect(verifyPackagedPrimeAgent(resources, packagedEntries, {
        extractPackageFile,
        vendorDirectory: join(repositoryRoot, "vendor", "prime-agent"),
        verifyDependencyClosure: () => manifest.dependencyClosureSha256ByTarget["darwin-arm64"],
        targetKey: "darwin-arm64",
      })).resolves.toMatchObject({ sourceCommit: manifest.source.commit, packages: 4 });
      expect(Object.keys(manifest.dependencyClosureSha256ByTarget).sort()).toEqual([
        "darwin-arm64",
        "darwin-x64",
        "win32-x64",
      ]);

      const copiedVendor = join(resources, "vendor");
      await mkdir(copiedVendor, { recursive: true });
      for (const entry of manifest.packages) {
        await cp(join(repositoryRoot, "vendor", "prime-agent", entry.file), join(copiedVendor, entry.file));
      }
      const codingArchive = manifest.packages.find(({ name }) => name === "@earendil-works/pi-coding-agent").file;
      const codingArchivePath = join(copiedVendor, codingArchive);
      await writeFile(codingArchivePath, Buffer.concat([await readFile(codingArchivePath), Buffer.from("mutation")]));
      await expect(verifyPackagedPrimeAgent(resources, packagedEntries, {
        extractPackageFile,
        vendorDirectory: copiedVendor,
        verifyDependencyClosure: () => manifest.dependencyClosureSha256ByTarget["darwin-arm64"],
        targetKey: "darwin-arm64",
      })).rejects.toThrow("archive hash mismatch");

      await expect(verifyPackagedPrimeAgent(resources, packagedEntries, {
        extractPackageFile: (_asar, path) => {
          const bytes = readFileSync(join(repositoryRoot, path));
          return path === "node_modules/@earendil-works/pi-coding-agent/dist/index.js"
            ? Buffer.concat([bytes, Buffer.from("\n// mutation")])
            : bytes;
        },
        vendorDirectory: join(repositoryRoot, "vendor", "prime-agent"),
        verifyDependencyClosure: () => manifest.dependencyClosureSha256ByTarget["darwin-arm64"],
        targetKey: "darwin-arm64",
      })).rejects.toThrow("package bytes mismatch");

      await expect(verifyPackagedPrimeAgent(resources, packagedEntries, {
        extractPackageFile: (_asar, path) => {
          const bytes = readFileSync(join(repositoryRoot, path));
          if (path !== "node_modules/@earendil-works/pi-coding-agent/package.json") return bytes;
          const metadata = JSON.parse(bytes.toString("utf8"));
          metadata.main = "dist/unreviewed-entrypoint.js";
          return Buffer.from(JSON.stringify(metadata));
        },
        vendorDirectory: join(repositoryRoot, "vendor", "prime-agent"),
        verifyDependencyClosure: () => manifest.dependencyClosureSha256ByTarget["darwin-arm64"],
        targetKey: "darwin-arm64",
      })).rejects.toThrow("package metadata mismatch");

      await writeFile(join(resources, "harnesses", "prime-agent-basic.yaml"), "mutated\n");
      await expect(verifyPackagedPrimeAgent(resources, packagedEntries, {
        extractPackageFile,
        vendorDirectory: join(repositoryRoot, "vendor", "prime-agent"),
        verifyDependencyClosure: () => manifest.dependencyClosureSha256ByTarget["darwin-arm64"],
        targetKey: "darwin-arm64",
      })).rejects.toThrow("harness integrity mismatch");
      await expect(inspectPrimeAgentRuntime({
        appPath: repositoryRoot,
        harnessDirectory: join(resources, "harnesses"),
        manifestPath: join(resources, "prime-agent", "manifest.json"),
        pythonClientRoot: join(resources, "python", "relayer-graph", "src"),
        platform: "darwin",
        architecture: "arm64",
      })).resolves.toMatchObject({ available: false, code: "prime_agent_assets_missing" });
      await rm(join(resources, "harnesses", "prime-agent-basic.yaml"));
      await expect(verifyPackagedPrimeAgent(resources, packagedEntries, {
        extractPackageFile,
        vendorDirectory: join(repositoryRoot, "vendor", "prime-agent"),
        verifyDependencyClosure: () => manifest.dependencyClosureSha256ByTarget["darwin-arm64"],
        targetKey: "darwin-arm64",
      })).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(resources, { recursive: true, force: true });
    }
  });

  it("fails closed with a stable harness-neutral reason for Windows default Auto", async () => {
    const rejected = await inspectPrimeAgentRuntime({
      appPath: "C:\\Program Files\\Relayer\\resources\\app.asar",
      harnessDirectory: "C:\\Program Files\\Relayer\\resources\\harnesses",
      manifestPath: "C:\\secret-profile\\manifest.json",
      pythonClientRoot: "C:\\secret-profile\\python",
      platform: "win32",
      defaultPermissionProfileId: "auto",
      importPrimeAgent: async () => { throw new Error("secret import detail"); },
    });
    expect(rejected).toMatchObject({
      available: false,
      code: "prime_agent_boundary_unsupported",
      message: "Prime Agent Ask and Auto require macOS. Choose another available harness on this device.",
    });
    expect(JSON.stringify(rejected)).not.toContain("secret-profile");
    expect(JSON.stringify(rejected)).not.toContain("secret import detail");
  });

  it("packages basic and deep without the development layered configuration", () => {
    const contract = resolveDesktopReleaseContract({
      environment: { RELAYER_DESKTOP_TARGET: "macos-arm64" },
      version: "0.2.14",
    });
    const config = createDesktopBuilderConfig(contract, {
      environment: { RELAYER_DESKTOP_TARGET: "macos-arm64" },
      argv: [],
    });
    const resources = config.extraResources.map(({ to }) => to);
    expect(resources).toContain("harnesses/prime-agent-basic.yaml");
    expect(resources).toContain("harnesses/prime-agent-deep.yaml");
    expect(resources).not.toContain("harnesses/prime-agent-layered-navigation-luna.yaml");
    expect(resources).toContain("python/relayer-graph/src/relayer_graph");
    expect(resources).toContain("prime-agent/manifest.json");
    expect(config.files).toContain("!node_modules/@earendil-works/pi-ai/dist/providers/faux.*");
  });
});
