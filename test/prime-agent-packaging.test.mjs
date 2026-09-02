import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
  normalizePackagedBundlePermissions,
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

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return null;
}

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
  it("seals the reviewed Prime closure: pins, digests, byte ordering, and signed variance", async () => {
    const attributes = await readFile(join(repositoryRoot, ".gitattributes"), "utf8");
    expect(attributes.split(/\r?\n/), "integrity-bound source assets stay LF across host checkouts").toEqual(expect.arrayContaining([
      "harnesses/*.yaml text eol=lf",
      "python/relayer-graph/src/relayer_graph/**/*.py text eol=lf",
    ]));
    expect(asarEntryPath("/node_modules/@earendil-works/pi-agent-core/package.json", "darwin"),
      "darwin asar entries drop the leading separator").toBe("node_modules/@earendil-works/pi-agent-core/package.json");
    expect(asarEntryPath("\\node_modules\\@earendil-works\\pi-agent-core\\package.json", "win32"),
      "win32 asar entries keep backslashes").toBe("node_modules\\@earendil-works\\pi-agent-core\\package.json");

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const lockfile = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8"));
    const desktopManifest = JSON.parse(await readFile(join(repositoryRoot, "desktop", "package.json"), "utf8"));
    expect(manifest.source.commit, "the reviewed Prime source commit").toBe("f6130839ad3043f1cd3d5294fe03023035bfcd5c");
    expect(manifest.runtimeContract.modelScopeAccess, "the model scope access contract").toBe("upfront-request-access@1");
    expect(manifest.packages, "the vendored package inventory").toHaveLength(4);
    for (const entry of manifest.packages) {
      const bytes = await readFile(join(repositoryRoot, "vendor", "prime-agent", entry.file));
      expect(createHash("sha256").update(bytes).digest("hex"), `${entry.name} archive hash`)
        .toBe(entry.sha256);
      const expectedResolution = `file:vendor/prime-agent/${entry.file}`;
      expect(lockfile.packages[`node_modules/${entry.name}`], `${entry.name} lockfile resolution`).toMatchObject({
        version: entry.version,
        resolved: expectedResolution,
      });
      expect(desktopManifest.dependencies[entry.name], `${entry.name} desktop dependency`)
        .toBe(`file:../vendor/prime-agent/${entry.file}`);
    }
    expect(JSON.stringify(lockfile), "the lockfile never embeds absolute user paths").not.toContain("/Users/");
    expect(JSON.stringify(lockfile), "the lockfile never resolves into prime-agent/packages").not.toContain("prime-agent/packages/");

    const root = "node_modules/@earendil-works/pi-coding-agent";
    const nested = `${root}/node_modules/nested-runtime`;
    const optional = "node_modules/optional-runtime";
    const peer = "node_modules/required-peer";
    const rootPackageJson = (main, extra = {}) => Buffer.from(JSON.stringify({
      name: "root",
      main,
      ...extra,
      dependencies: { "nested-runtime": "1.0.0" },
      optionalDependencies: { "optional-runtime": "1.0.0", "missing-optional": "1.0.0" },
      peerDependencies: { "required-peer": "1.0.0", "missing-optional-peer": "1.0.0" },
      peerDependenciesMeta: { "missing-optional-peer": { optional: true } },
    }));
    const files = new Map([
      [`${root}/package.json`, rootPackageJson("dist/index.js")],
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
    files.set(`${root}/package.json`, rootPackageJson("attacker.js", { exports: "./attacker.js" }));
    expect(digest(), "an entrypoint takeover changes the closure digest").not.toBe(baseline);
    files.set(`${root}/package.json`, rootPackageJson("dist/index.js"));
    files.set(`${nested}/index.js`, Buffer.from("module.exports = 'mutated';\n"));
    expect(digest(), "a mutated precedence-winning nested dependency changes the digest").not.toBe(baseline);
    files.set(`${nested}/index.js`, Buffer.from("module.exports = true;\n"));
    files.set(`${optional}/index.js`, Buffer.from("module.exports = 'mutated optional';\n"));
    expect(digest(), "a mutated optional dependency changes the digest").not.toBe(baseline);
    files.set(`${optional}/index.js`, Buffer.from("module.exports = 'optional';\n"));
    files.set(`${peer}/index.js`, Buffer.from("module.exports = 'mutated peer';\n"));
    expect(digest(), "a mutated peer dependency changes the digest").not.toBe(baseline);
    entries = new Set([...entries].filter((path) => !path.startsWith(`${peer}/`)));
    expect(digest, "a missing required peer fails closed").toThrow("required-peer is unresolved");

    const integrityModule = new URL("../desktop/shared/prime-runtime-integrity.mjs", import.meta.url).href;
    const localeSource = `
      import { digestFileEntries } from ${JSON.stringify(integrityModule)};
      const entries = [
        { path: "runtime/I.js", bytes: Buffer.from("upper") },
        { path: "runtime/ı.js", bytes: Buffer.from("dotless") },
        { path: "runtime/i.js", bytes: Buffer.from("lower") },
      ];
      process.stdout.write(digestFileEntries(entries));
    `;
    const runLocale = async (locale) => (await execFileAsync(process.execPath, ["--input-type=module", "--eval", localeSource], {
      env: { ...process.env, LC_ALL: locale, LANG: locale },
    })).stdout;
    expect(await runLocale("tr_TR.UTF-8"), "integrity digests ignore locale-specific collation")
      .toBe(await runLocale("en_US.UTF-8"));

    const unsignedEntries = [
      { path: "node_modules/runtime/index.js", bytes: Buffer.from("reviewed JavaScript") },
      { path: "node_modules/runtime/addon.node", bytes: machONativeBytes("unsigned signature") },
    ];
    const snapshot = createSignedDependencyClosureSnapshot(unsignedEntries, "darwin-arm64");
    const signedEntries = [
      unsignedEntries[0],
      { path: "node_modules/runtime/addon.node", bytes: machONativeBytes("Developer ID signature") },
    ];
    expect(() => verifySignedDependencyClosureSnapshot(signedEntries, snapshot, "darwin-arm64"),
      "signing variance on snapshotted Mach-O binaries is permitted").not.toThrow();
    const signedVarianceCorpus = [
      ["mutated JavaScript", [{ path: "node_modules/runtime/index.js", bytes: Buffer.from("mutated JavaScript") }, signedEntries[1]], snapshot, "darwin-arm64", "signed immutable closure mismatch"],
      ["a missing native binary", [signedEntries[0]], snapshot, "darwin-arm64", "signed native-code inventory mismatch"],
      ["an added native binary", [...signedEntries, { path: "node_modules/runtime/added.node", bytes: machONativeBytes("added signature") }], snapshot, "darwin-arm64", "signed native-code inventory mismatch"],
      ["a non-Mach-O replacement", [signedEntries[0], { path: signedEntries[1].path, bytes: Buffer.from("not Mach-O") }], snapshot, "darwin-arm64", "signed native-code inventory mismatch"],
      ["a different target", signedEntries, snapshot, "darwin-x64", "signed closure snapshot is invalid"],
      ["a schema-version bump", signedEntries, { ...snapshot, schemaVersion: 2 }, "darwin-arm64", "signed closure snapshot is invalid"],
    ];
    expect(signedVarianceCorpus, "signed variance rejection inventory").toHaveLength(6);
    for (const [label, mutatedEntries, mutatedSnapshot, target, message] of signedVarianceCorpus) {
      expect(() => verifySignedDependencyClosureSnapshot(mutatedEntries, mutatedSnapshot, target), label)
        .toThrow(message);
    }
  });

  it("discovers, inspects, and verifies the packaged Prime runtime end to end", { timeout: 120_000 }, async () => {
    // The first dynamic import of the vendored Prime package plus the bundled
    // skill-directory scan exceeded the default 5s timeout on loaded runners.
    const { loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent");
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
    const { skills } = loadSkillsFromDir({ dir: join(packageRoot, "skills"), source: "builtin" });
    const browser = skills.find(({ name }) => name === "browser");
    expect(browser, "the browser route ships as a Python skill").toMatchObject({
      name: "browser",
      kind: "python",
      python: { importName: "browser" },
    });
    for (const name of ["prime-agent-basic.yaml", "prime-agent-deep.yaml"]) {
      const configuration = await readFile(join(repositoryRoot, "harnesses", name), "utf8");
      expect(configuration, `${name} pins the Ask boundary`).toContain("ask:\n    boundary: workspace-write@1");
      expect(configuration, `${name} pins the Auto boundary`).toContain("auto:\n    boundary: workspace-write@1");
      expect(configuration, `${name} leaves Full unbounded`).toContain("full: {}");
    }

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const codingAgent = manifest.packages.find(({ name }) => name === "@earendil-works/pi-coding-agent");
    const sourcePath = "package/skills/browser/src/browser/__init__.py";
    const distPath = "package/dist/skills/browser/src/browser/__init__.py";
    const archiveFiles = await readArchiveFiles(
      join(repositoryRoot, "vendor", "prime-agent", codingAgent.file),
      new Set([sourcePath, distPath]),
    );
    expect(archiveFiles.get(sourcePath), "source and dist browser helpers are byte-identical")
      .toEqual(archiveFiles.get(distPath));
    const helper = archiveFiles.get(sourcePath)?.toString("utf8") ?? "";
    for (const token of [
      'element.matches(":disabled")',
      'element.getAttribute("aria-disabled") === "true"',
      "HTMLElement.prototype.click.call(element)",
      "return {{ previous, current: String(element.value) }};",
      "if current != value:",
      "page rejected or sanitized the requested fill value",
      "Replace and verify an input value, then disconnect this terminal page action.",
      "Click one matching element, then disconnect this terminal page action.",
      '"Page.lifecycleEvent",',
      '"Page.navigatedWithinDocument",',
      'params.get("loaderId") == loader_id',
      'params.get("frameId") == frame_id',
      '_normalized_navigation_url(params["url"]) == normalized_url',
    ]) {
      expect.soft(helper, `browser helper keeps ${token}`).toContain(token);
    }
    expect(helper.match(/await asyncio\.shield\(self\.close\(\)\)/g), "every terminal action shields close")
      .toHaveLength(4);

    await expect(inspectPrimeAgentRuntime({
      appPath: repositoryRoot,
      harnessDirectory: join(repositoryRoot, "harnesses"),
      manifestPath,
      pythonClientRoot: join(repositoryRoot, "python", "relayer-graph", "src"),
      platform: "darwin",
      architecture: "arm64",
    }), "the exact runtime API, configs, and Python client are admitted").resolves.toMatchObject({
      available: true,
      sourceCommit: "f6130839ad3043f1cd3d5294fe03023035bfcd5c",
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
    expect(rejected, "a weakened runtime API fails closed with an update message").toMatchObject({
      available: false,
      code: "prime_agent_api_incompatible",
      message: "This Relayer build cannot use the packaged Prime Agent API. Update Relayer.",
      diagnostics: {
        sourceCommit: "f6130839ad3043f1cd3d5294fe03023035bfcd5c",
        packages: expect.arrayContaining([{ name: "@earendil-works/pi-coding-agent", version: "0.8.1" }]),
      },
    });
    expect(JSON.stringify(rejected), "API rejection never leaks unreviewed function names")
      .not.toContain("createAgentRunModelScope");

    for (const [label, mutate] of [
      ["duplicate harness configurations", (candidate) => { candidate.harnessConfigurations = ["prime-agent-basic.yaml", "prime-agent-basic.yaml"]; }],
      ["emptied runtime constants", (candidate) => { candidate.runtimeContract.constants = {}; }],
      ["emptied runtime functions", (candidate) => { candidate.runtimeContract.functions = []; }],
      ["emptied session functions", (candidate) => { candidate.runtimeContract.sessionFunctions = []; }],
    ]) {
      const candidate = structuredClone(manifest);
      mutate(candidate);
      expect.soft(() => validatePrimeAgentManifest(candidate), label).toThrow();
    }

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
      const packagedEntries = new Set((await Promise.all(manifest.packages.map(async (entry) => {
        const prefix = `node_modules/${entry.name}/`;
        return (await packageFileEntries(
          join(repositoryRoot, "node_modules", ...entry.name.split("/")),
          `node_modules/${entry.name}`,
        )).filter((path) => path === `${prefix}package.json` || primeRuntimeSourcePathIsPackaged(path.slice(prefix.length)));
      }))).flat());
      for (const path of PACKAGED_PROVIDER_MODULES) packagedEntries.add(`main/${path}`);
      const extractPackageFile = (_asar, path) => readFileSync(join(repositoryRoot, path));
      const verifyOptions = (overrides = {}) => ({
        extractPackageFile,
        vendorDirectory: join(repositoryRoot, "vendor", "prime-agent"),
        verifyDependencyClosure: () => manifest.dependencyClosureSha256ByTarget["darwin-arm64"],
        targetKey: "darwin-arm64",
        ...overrides,
      });

      await expect(verifyPackagedPrimeAgent(resources, packagedEntries, verifyOptions()),
        "reviewed packaged bytes verify against the manifest").resolves.toMatchObject({
        sourceCommit: manifest.source.commit, packages: 4,
      });
      expect((await rejectionOf(verifyPackagedPrimeAgent(resources, packagedEntries, verifyOptions({
        verifyDependencyClosure: () => "unreviewed-closure",
      }))))?.message ?? "promise resolved instead of rejecting", "an unreviewed dependency closure fails closed").toMatch("dependency closure mismatch");
      expect(Object.keys(manifest.dependencyClosureSha256ByTarget).sort(),
        "only the supported packaged target carries a closure hash").toEqual(["darwin-arm64"]);

      const copiedVendor = join(resources, "vendor");
      await mkdir(copiedVendor, { recursive: true });
      for (const entry of manifest.packages) {
        await cp(join(repositoryRoot, "vendor", "prime-agent", entry.file), join(copiedVendor, entry.file));
      }
      const codingArchive = manifest.packages.find(({ name }) => name === "@earendil-works/pi-coding-agent").file;
      const codingArchivePath = join(copiedVendor, codingArchive);
      await writeFile(codingArchivePath, Buffer.concat([await readFile(codingArchivePath), Buffer.from("mutation")]));
      expect((await rejectionOf(verifyPackagedPrimeAgent(resources, packagedEntries, verifyOptions({ vendorDirectory: copiedVendor }))))?.message ?? "promise resolved instead of rejecting", "a mutated vendor archive fails closed").toMatch("archive hash mismatch");

      expect((await rejectionOf(verifyPackagedPrimeAgent(resources, packagedEntries, verifyOptions({
        extractPackageFile: (_asar, path) => {
          const bytes = readFileSync(join(repositoryRoot, path));
          return path === "node_modules/@earendil-works/pi-coding-agent/dist/index.js"
            ? Buffer.concat([bytes, Buffer.from("\n// mutation")])
            : bytes;
        },
      }))))?.message ?? "promise resolved instead of rejecting", "mutated package bytes fail closed").toMatch("package bytes mismatch");

      expect((await rejectionOf(verifyPackagedPrimeAgent(resources, packagedEntries, verifyOptions({
        extractPackageFile: (_asar, path) => {
          const bytes = readFileSync(join(repositoryRoot, path));
          if (path !== "node_modules/@earendil-works/pi-coding-agent/package.json") return bytes;
          const metadata = JSON.parse(bytes.toString("utf8"));
          metadata.main = "dist/unreviewed-entrypoint.js";
          return Buffer.from(JSON.stringify(metadata));
        },
      }))))?.message ?? "promise resolved instead of rejecting", "an unreviewed package entrypoint fails closed").toMatch("package metadata mismatch");

      await writeFile(join(resources, "harnesses", "prime-agent-basic.yaml"), "mutated\n");
      expect((await rejectionOf(verifyPackagedPrimeAgent(resources, packagedEntries, verifyOptions())))?.message ?? "promise resolved instead of rejecting", "a mutated harness configuration fails closed").toMatch("harness integrity mismatch");
      await expect(inspectPrimeAgentRuntime({
        appPath: repositoryRoot,
        harnessDirectory: join(resources, "harnesses"),
        manifestPath: join(resources, "prime-agent", "manifest.json"),
        pythonClientRoot: join(resources, "python", "relayer-graph", "src"),
        platform: "darwin",
        architecture: "arm64",
      }), "the runtime inspector reports missing assets").resolves.toMatchObject({
        available: false, code: "prime_agent_assets_missing",
      });
      await rm(join(resources, "harnesses", "prime-agent-basic.yaml"));
      expect(await rejectionOf(verifyPackagedPrimeAgent(resources, packagedEntries, verifyOptions())), "a deleted harness configuration surfaces ENOENT").toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(resources, { recursive: true, force: true });
    }

    const signedRuntimeDirectory = await mkdtemp(join(tmpdir(), "relayer-signed-prime-runtime-"));
    const packagedAppPath = join(signedRuntimeDirectory, "app.asar");
    try {
      await symlink(repositoryRoot, packagedAppPath, "dir");
      const unsignedEntries = [
        { path: "node_modules/runtime/index.js", bytes: Buffer.from("reviewed JavaScript") },
        { path: "node_modules/runtime/addon.node", bytes: machONativeBytes("unsigned signature") },
      ];
      await expect(inspectPrimeAgentRuntime({
        appPath: packagedAppPath,
        architecture: "arm64",
        collectDependencyClosure: async () => [
          unsignedEntries[0],
          { path: "node_modules/runtime/addon.node", bytes: machONativeBytes("Developer ID signature") },
        ],
        harnessDirectory: join(repositoryRoot, "harnesses"),
        integrityPhase: "signed",
        manifestPath,
        platform: "darwin",
        pythonClientRoot: join(repositoryRoot, "python", "relayer-graph", "src"),
        readSignedClosureSnapshot: async () => createSignedDependencyClosureSnapshot(unsignedEntries, "darwin-arm64"),
      }), "a signed runtime is admitted after walking its mutated native closure").resolves.toMatchObject({
        available: true,
        configurationNames: ["prime-agent-basic", "prime-agent-deep"],
      });
    } finally {
      await rm(signedRuntimeDirectory, { recursive: true, force: true });
    }

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
            LSMinimumSystemVersion: "13.3.0",
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
      }), "macOS verification admits the signed application").resolves.toMatchObject({
        appPath, expectedTeamId: "NZ253AL7U6",
      });
      expect(verificationOrder, "the app signature is verified before bundle verification")
        .toEqual(["signature", "bundle"]);
      expect(bundleCalls, "bundle verification runs in the signed integrity phase").toEqual([[appPath, expect.objectContaining({
        expectedArchitecture: "arm64",
        primeAgentIntegrityPhase: "signed",
      })]]);
    } finally {
      await rm(appPath, { recursive: true, force: true });
    }

    const windowsRejected = await inspectPrimeAgentRuntime({
      appPath: "C:\\Program Files\\Relayer\\resources\\app.asar",
      harnessDirectory: "C:\\Program Files\\Relayer\\resources\\harnesses",
      manifestPath: "C:\\secret-profile\\manifest.json",
      pythonClientRoot: "C:\\secret-profile\\python",
      platform: "win32",
      defaultPermissionProfileId: "auto",
      importPrimeAgent: async () => { throw new Error("secret import detail"); },
    });
    expect(windowsRejected, "Windows default Auto fails closed with a stable harness-neutral reason").toMatchObject({
      available: false,
      code: "prime_agent_boundary_unsupported",
      message: "Prime Agent Ask and Auto require macOS. Choose another available harness on this device.",
    });
    expect(JSON.stringify(windowsRejected), "the Windows rejection never leaks local paths").not.toContain("secret-profile");
    expect(JSON.stringify(windowsRejected), "the Windows rejection never leaks import errors").not.toContain("secret import detail");
  });

  it("packages the release harness set and widens bundle permissions without following symlinks", async () => {
    const contract = resolveDesktopReleaseContract({
      environment: { RELAYER_DESKTOP_TARGET: "macos-arm64" },
      version: "0.2.14",
    });
    const config = createDesktopBuilderConfig(contract, {
      environment: { RELAYER_DESKTOP_TARGET: "macos-arm64" },
      argv: [],
    });
    const resources = config.extraResources.map(({ to }) => to);
    expect(resources, "basic and deep harnesses ship").toContain("harnesses/prime-agent-basic.yaml");
    expect(resources, "the deep harness ships").toContain("harnesses/prime-agent-deep.yaml");
    expect(resources, "the development layered configuration never ships")
      .not.toContain("harnesses/prime-agent-layered-navigation-luna.yaml");
    expect(resources, "the Python graph client ships").toContain("python/relayer-graph/src/relayer_graph");
    expect(resources, "the Prime manifest ships").toContain("prime-agent/manifest.json");
    expect(config.files, "faux provider builds are excluded").toContain("!node_modules/@earendil-works/pi-ai/dist/providers/faux.*");

    // Signed CI builds shipped a 0700 application, so Spotlight and Launch
    // Services could not index it and it never appeared in search. Local builds
    // were already 0755, so only a release DMG reproduced it.
    const directory = await mkdtemp(join(tmpdir(), "relayer-bundle-permissions-"));
    try {
      const appPath = join(directory, "Relayer.app");
      const macOsDirectory = join(appPath, "Contents", "MacOS");
      await mkdir(macOsDirectory, { recursive: true });
      await writeFile(join(appPath, "Contents", "Info.plist"), "plist");
      await writeFile(join(macOsDirectory, "Relayer"), "binary");
      await symlink("Info.plist", join(appPath, "Contents", "Current.plist"));
      await chmod(join(macOsDirectory, "Relayer"), 0o700);
      await chmod(join(appPath, "Contents", "Info.plist"), 0o600);
      await chmod(macOsDirectory, 0o700);
      await chmod(join(appPath, "Contents"), 0o700);
      await chmod(appPath, 0o700);

      await normalizePackagedBundlePermissions(appPath);

      const modeOf = async (path) => ((await lstat(path)).mode & 0o7777).toString(8);
      expect(await modeOf(appPath), "the app bundle widens to 755").toBe("755");
      expect(await modeOf(join(appPath, "Contents")), "Contents widens to 755").toBe("755");
      expect(await modeOf(macOsDirectory), "MacOS widens to 755").toBe("755");
      expect(await modeOf(join(macOsDirectory, "Relayer")), "the executable widens to 755").toBe("755");
      // A plain file stays non-executable; only readability widens.
      expect(await modeOf(join(appPath, "Contents", "Info.plist")), "plain files widen to 644 without execute").toBe("644");
      // The symlink target keeps the mode it was given through its own path.
      expect(await modeOf(join(appPath, "Contents", "Info.plist")), "symlinks are never followed for permission changes").toBe("644");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
