import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as tar from "tar";
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
import {
  createSignedDependencyClosureSnapshot,
  primeRuntimeSourcePathIsPackaged,
  verifySignedDependencyClosureSnapshot,
} from "../desktop/shared/prime-runtime-integrity.mjs";
import { resolveDesktopReleaseContract } from "../desktop/release/contract.mjs";
import { verifyMacOSApplication } from "../desktop/release/verify-macos-app.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const manifestPath = join(repositoryRoot, "vendor", "prime-agent", "manifest.json");
const execFileAsync = promisify(execFile);
const machONativeBytes = (signature) => Buffer.concat([
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from(signature),
]);

async function packageFileEntries(root, relativeRoot, output = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const relativePath = join(relativeRoot, entry.name).replaceAll("\\", "/");
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) await packageFileEntries(absolutePath, relativePath, output);
    else if (entry.isFile()) output.push(relativePath);
  }
  return output;
}

async function readArchiveFiles(archivePath, wantedPaths) {
  const files = new Map();
  await tar.t({
    file: archivePath,
    onentry(entry) {
      if (!wantedPaths.has(entry.path)) {
        entry.resume();
        return;
      }
      const chunks = [];
      entry.on("data", (chunk) => chunks.push(chunk));
      entry.on("end", () => files.set(entry.path, Buffer.concat(chunks)));
    },
  });
  return files;
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

    expect(manifest.source.commit).toBe("f6130839ad3043f1cd3d5294fe03023035bfcd5c");
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
    for (const name of ["prime-agent.yaml", "prime-agent-deep.yaml"]) {
      const configuration = await readFile(join(repositoryRoot, "harnesses", name), "utf8");
      expect(configuration).toContain("ask:\n    boundary: workspace-write@1");
      expect(configuration).toContain("auto:\n    boundary: workspace-write@1");
      expect(configuration).toContain("full: {}");
    }
  });

  it("ships the tested browser helper at both production skill paths", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const codingAgent = manifest.packages.find(({ name }) => name === "@earendil-works/pi-coding-agent");
    const sourcePath = "package/skills/browser/src/browser/__init__.py";
    const distPath = "package/dist/skills/browser/src/browser/__init__.py";
    const archiveFiles = await readArchiveFiles(
      join(repositoryRoot, "vendor", "prime-agent", codingAgent.file),
      new Set([sourcePath, distPath]),
    );
    expect(archiveFiles.get(sourcePath)).toEqual(archiveFiles.get(distPath));

    const helper = archiveFiles.get(sourcePath)?.toString("utf8") ?? "";
    expect(helper).toContain('element.matches(":disabled")');
    expect(helper).toContain('element.getAttribute("aria-disabled") === "true"');
    expect(helper).toContain("HTMLElement.prototype.click.call(element)");
    expect(helper).toContain("return {{ previous, current: String(element.value) }};");
    expect(helper).toContain("if current != value:");
    expect(helper).toContain("page rejected or sanitized the requested fill value");
    expect(helper).toContain("Replace and verify an input value, then disconnect this terminal page action.");
    expect(helper).toContain("Click one matching element, then disconnect this terminal page action.");
    expect(helper.match(/await asyncio\.shield\(self\.close\(\)\)/g)).toHaveLength(4);
    expect(helper).toContain('"Page.lifecycleEvent",');
    expect(helper).toContain('"Page.navigatedWithinDocument",');
    expect(helper).toContain('params.get("loaderId") == loader_id');
    expect(helper).toContain('params.get("frameId") == frame_id');
    expect(helper).toContain('_normalized_navigation_url(params["url"]) == normalized_url');
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
      sourceCommit: "f6130839ad3043f1cd3d5294fe03023035bfcd5c",
      configurationNames: ["prime-agent"],
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
        sourceCommit: "f6130839ad3043f1cd3d5294fe03023035bfcd5c",
        packages: expect.arrayContaining([{ name: "@earendil-works/pi-coding-agent", version: "0.8.1" }]),
      },
    });
    expect(JSON.stringify(rejected)).not.toContain("createAgentRunModelScope");
  });

  it("rejects manifests that duplicate configurations or weaken the runtime API", async () => {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const mutate of [
      (candidate) => { candidate.harnessConfigurations = ["prime-agent.yaml", "prime-agent.yaml"]; },
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
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      for (const name of manifest.harnessConfigurations) {
        await cp(join(repositoryRoot, "harnesses", name), join(resources, "harnesses", name));
      }
      await cp(
        join(repositoryRoot, "python", "relayer-graph", "src", "relayer_graph"),
        join(resources, "python", "relayer-graph", "src", "relayer_graph"),
        { recursive: true },
      );
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
      await expect(verifyPackagedPrimeAgent(resources, packagedEntries, {
        extractPackageFile,
        vendorDirectory: join(repositoryRoot, "vendor", "prime-agent"),
        verifyDependencyClosure: () => "unreviewed-closure",
        targetKey: "darwin-arm64",
      })).rejects.toThrow("dependency closure mismatch");

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

      await writeFile(join(resources, "harnesses", "prime-agent.yaml"), "mutated\n");
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
      await rm(join(resources, "harnesses", "prime-agent.yaml"));
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

  it("permits only the snapshotted Mach-O signature variance after signing", () => {
    const unsignedEntries = [
      { path: "node_modules/runtime/index.js", bytes: Buffer.from("reviewed JavaScript") },
      {
        path: "node_modules/runtime/addon.node",
        bytes: machONativeBytes("unsigned signature"),
      },
    ];
    const snapshot = createSignedDependencyClosureSnapshot(unsignedEntries, "darwin-arm64");
    const signedEntries = [
      unsignedEntries[0],
      {
        path: "node_modules/runtime/addon.node",
        bytes: machONativeBytes("Developer ID signature"),
      },
    ];
    expect(() => verifySignedDependencyClosureSnapshot(signedEntries, snapshot, "darwin-arm64"))
      .not.toThrow();
    expect(() => verifySignedDependencyClosureSnapshot([
      { path: "node_modules/runtime/index.js", bytes: Buffer.from("mutated JavaScript") },
      signedEntries[1],
    ], snapshot, "darwin-arm64")).toThrow("signed immutable closure mismatch");
    expect(() => verifySignedDependencyClosureSnapshot([signedEntries[0]], snapshot, "darwin-arm64"))
      .toThrow("signed native-code inventory mismatch");
    expect(() => verifySignedDependencyClosureSnapshot([
      ...signedEntries,
      { path: "node_modules/runtime/added.node", bytes: machONativeBytes("added signature") },
    ], snapshot, "darwin-arm64")).toThrow("signed native-code inventory mismatch");
    expect(() => verifySignedDependencyClosureSnapshot([
      signedEntries[0],
      { path: signedEntries[1].path, bytes: Buffer.from("not Mach-O") },
    ], snapshot, "darwin-arm64")).toThrow("signed native-code inventory mismatch");
    expect(() => verifySignedDependencyClosureSnapshot(signedEntries, snapshot, "darwin-x64"))
      .toThrow("signed closure snapshot is invalid");
    expect(() => verifySignedDependencyClosureSnapshot(signedEntries, {
      ...snapshot,
      schemaVersion: 2,
    }, "darwin-arm64")).toThrow("signed closure snapshot is invalid");
  });

  it("uses the app signature instead of unsigned native hashes after macOS signing", async () => {
    const appPath = await mkdtemp(join(tmpdir(), "relayer-signed-prime-"));
    try {
      const bundleCalls = [];
      const verificationOrder = [];
      const execute = async (command, args) => {
        if (command === "/usr/bin/codesign" && args[0] === "--verify") {
          verificationOrder.push("signature");
        }
        if (command === "/usr/bin/codesign" && args[0] === "--display") {
          return {
            stdout: "",
            stderr: "Authority=Developer ID Application: Relayer, Inc.\nTeamIdentifier=NZ253AL7U6\n",
          };
        }
        if (command === "/usr/bin/plutil") {
          const values = {
            CFBundleIdentifier: "ai.relayer.desktop",
            CFBundleName: "Relayer",
            LSMinimumSystemVersion: "13.0.0",
          };
          return { stdout: `${values[args[1]]}\n`, stderr: "" };
        }
        if (command === "/usr/bin/lipo") return { stdout: "arm64\n", stderr: "" };
        return { stdout: "", stderr: "" };
      };
      await expect(verifyMacOSApplication(appPath, {
        execute,
        expectedArchitecture: "arm64",
        verifyBundle: async (...args) => {
          verificationOrder.push("bundle");
          bundleCalls.push(args);
        },
      })).resolves.toMatchObject({ appPath, expectedTeamId: "NZ253AL7U6" });
      expect(verificationOrder).toEqual(["signature", "bundle"]);
      expect(bundleCalls).toEqual([[appPath, expect.objectContaining({
        expectedArchitecture: "arm64",
        primeAgentIntegrityPhase: "signed",
      })]]);
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }
  });

  it("admits a signed packaged Prime runtime after walking its mutated native closure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-signed-prime-runtime-"));
    const packagedAppPath = join(directory, "app.asar");
    try {
      await symlink(repositoryRoot, packagedAppPath, "dir");
      const unsignedEntries = [
        { path: "node_modules/runtime/index.js", bytes: Buffer.from("reviewed JavaScript") },
        {
          path: "node_modules/runtime/addon.node",
          bytes: machONativeBytes("unsigned signature"),
        },
      ];
      const signedEntries = [
        unsignedEntries[0],
        {
          path: "node_modules/runtime/addon.node",
          bytes: machONativeBytes("Developer ID signature"),
        },
      ];
      await expect(inspectPrimeAgentRuntime({
        appPath: packagedAppPath,
        architecture: "arm64",
        collectDependencyClosure: async () => signedEntries,
        harnessDirectory: join(repositoryRoot, "harnesses"),
        integrityPhase: "signed",
        manifestPath,
        platform: "darwin",
        pythonClientRoot: join(repositoryRoot, "python", "relayer-graph", "src"),
        readSignedClosureSnapshot: async () => createSignedDependencyClosureSnapshot(
          unsignedEntries,
          "darwin-arm64",
        ),
      })).resolves.toMatchObject({
        available: true,
        configurationNames: ["prime-agent"],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

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

  it("packages only the product Prime configuration", () => {
    const contract = resolveDesktopReleaseContract({
      environment: { RELAYER_DESKTOP_TARGET: "macos-arm64" },
      version: "0.2.14",
    });
    const config = createDesktopBuilderConfig(contract, {
      environment: { RELAYER_DESKTOP_TARGET: "macos-arm64" },
      argv: [],
    });
    const resources = config.extraResources.map(({ to }) => to);
    expect(resources).toContain("harnesses/prime-agent.yaml");
    expect(resources).not.toContain("harnesses/prime-agent-deep.yaml");
    expect(resources).not.toContain("harnesses/prime-agent-layered-navigation-luna.yaml");
    expect(resources).toContain("python/relayer-graph/src/relayer_graph");
    expect(resources).toContain("prime-agent/manifest.json");
    expect(config.files).toContain("!node_modules/@earendil-works/pi-ai/dist/providers/faux.*");
  });
});
