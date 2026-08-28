import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { x as extractTar } from "tar";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");
export const defaultManifestPath = resolve(
  repositoryRoot,
  "vendor/ladybug/source-build-manifest.json",
);

function assertHexDigest(value, label) {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

export function validateLadybugSourceManifest(manifest) {
  if (manifest.schemaVersion !== 1) throw new Error("unsupported Ladybug source manifest");
  if (manifest.core.version !== "0.18.0") throw new Error("Ladybug core must remain 0.18.0");
  if (manifest.core.commit !== "0cda4fffcebb4a52cc24198462901ad28e2d5b66") {
    throw new Error("unexpected Ladybug core commit");
  }
  if (manifest.rustBinding.crate !== "lbug" || manifest.rustBinding.version !== "0.18.0") {
    throw new Error("Rust binding must remain lbug 0.18.0");
  }
  if (manifest.openssl.version !== "3.5.8") throw new Error("OpenSSL must remain 3.5.8");
  if (!Array.isArray(manifest.extensions) || manifest.extensions.length !== 0) {
    throw new Error("Ladybug v1 source build must not load extensions");
  }
  if (manifest.build.nativeMode !== "fully-static-ladybug-and-openssl") {
    throw new Error("Ladybug and OpenSSL must link into the Rust binary statically");
  }
  if (manifest.build.bindingPatch !== null || manifest.build.corePatch !== null) {
    throw new Error("Ladybug source build does not admit binding or core patches");
  }
  const expectedLinkAdapter = {
    ownership: "relayer",
    ladybugSourcePatched: false,
    targets: [
      { rustTarget: "aarch64-apple-darwin", libraryDirectory: "openssl-prefix/lib", staticLibraries: ["ssl", "crypto"] },
      { rustTarget: "x86_64-apple-darwin", libraryDirectory: "openssl-prefix/lib", staticLibraries: ["ssl", "crypto"] },
      { rustTarget: "x86_64-pc-windows-msvc", libraryDirectory: "openssl-prefix/lib", staticLibraries: ["libssl", "libcrypto"] },
    ],
  };
  if (JSON.stringify(manifest.build.platformLinkAdapter) !== JSON.stringify(expectedLinkAdapter)) {
    throw new Error("Ladybug 0.18.0 requires the reviewed Relayer-owned OpenSSL link adapter");
  }
  if (manifest.build.cargoNetworkMode !== "offline") {
    throw new Error("Ladybug Cargo builds must be offline");
  }
  for (const target of [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
  ]) {
    if (manifest.build.targets[target]?.supported !== true) {
      throw new Error(`Ladybug source build must support ${target}`);
    }
  }
  const forbiddenEnvironment = [
    "LBUG_GITHUB_REPOSITORY",
    "LBUG_INCLUDE_DIR",
    "LBUG_LIBRARY_DIR",
    "LBUG_PRECOMPILED_RUN_ID",
    "LBUG_RUST_BUILD_FROM_SOURCE",
    "LBUG_SHARED",
  ];
  if (JSON.stringify(manifest.build.environmentMustBeUnset) !== JSON.stringify(forbiddenEnvironment)) {
    throw new Error("Ladybug source build must reject ambient source/library overrides");
  }
  for (const [value, label] of [
    [manifest.core.embeddedTreeSha256, "embedded Ladybug core tree"],
    [manifest.rustBinding.sha256, "lbug crate"],
    [manifest.rustBinding.buildScriptSha256, "lbug build script"],
    [manifest.openssl.sha256, "OpenSSL source"],
  ]) assertHexDigest(value, label);
  for (const source of [manifest.rustBinding, manifest.openssl]) {
    if (basename(source.archive) !== source.archive) {
      throw new Error(`unsafe source archive name: ${source.archive}`);
    }
    const url = new URL(source.url);
    if (url.protocol !== "https:") throw new Error(`source URL must use HTTPS: ${source.url}`);
  }
  if (manifest.licenseReceipt.completeForDistribution !== false) {
    throw new Error("source preparation must not claim the incomplete license receipt is shippable");
  }
  return manifest;
}

export async function loadLadybugSourceManifest(path = defaultManifestPath) {
  return validateLadybugSourceManifest(JSON.parse(await readFile(path, "utf8")));
}

export async function sha256File(path) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

function sourceEntries(manifest) {
  return [
    { id: "rust-binding", ...manifest.rustBinding },
    { id: "openssl", ...manifest.openssl },
  ];
}

export async function verifyLadybugSourceCache({ cacheDirectory, manifest }) {
  validateLadybugSourceManifest(manifest);
  const receipts = [];
  for (const source of sourceEntries(manifest)) {
    const path = resolve(cacheDirectory, source.archive);
    const actualSha256 = await sha256File(path).catch((error) => {
      if (error.code === "ENOENT") throw new Error(`missing pinned source archive: ${source.archive}`);
      throw error;
    });
    if (actualSha256 !== source.sha256) {
      throw new Error(
        `${source.archive} SHA-256 mismatch: expected ${source.sha256}, received ${actualSha256}`,
      );
    }
    receipts.push({ id: source.id, archive: source.archive, sha256: actualSha256 });
  }
  return receipts;
}

async function fetchOneSource(cacheDirectory, source) {
  const destination = resolve(cacheDirectory, source.archive);
  try {
    await access(destination);
    const existing = await sha256File(destination);
    if (existing !== source.sha256) {
      throw new Error(`refusing to replace mismatched cached source: ${source.archive}`);
    }
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const temporaryDirectory = await mkdtemp(join(cacheDirectory, ".download-"));
  const temporaryPath = join(temporaryDirectory, source.archive);
  try {
    const response = await fetch(source.url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`source download failed (${response.status}): ${source.url}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryPath, { flags: "wx" }));
    const actual = await sha256File(temporaryPath);
    if (actual !== source.sha256) {
      throw new Error(`${source.archive} download SHA-256 mismatch`);
    }
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function fetchLadybugSourceCache({ cacheDirectory, manifest }) {
  validateLadybugSourceManifest(manifest);
  await mkdir(cacheDirectory, { recursive: true });
  for (const source of sourceEntries(manifest)) await fetchOneSource(cacheDirectory, source);
  return verifyLadybugSourceCache({ cacheDirectory, manifest });
}

async function requireEmptyDirectory(path) {
  await mkdir(path, { recursive: true });
  const entries = await readdir(path);
  if (entries.length !== 0) throw new Error(`refusing to stage into non-empty directory: ${path}`);
}

export async function digestLadybugSourceTree(root) {
  const digest = createHash("sha256");
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const normalized = relative(root, path).replaceAll("\\", "/");
      const info = await lstat(path);
      if (info.isDirectory()) {
        digest.update(`D\0${normalized}\0`);
        await visit(path);
      } else if (info.isSymbolicLink()) {
        digest.update(`L\0${normalized}\0${await readlink(path)}\0`);
      } else if (info.isFile()) {
        const bytes = await readFile(path);
        digest.update(`F\0${normalized}\0${bytes.length}\0`);
        digest.update(bytes);
      } else {
        throw new Error(`unsupported source entry: ${normalized}`);
      }
    }
  }
  await visit(root);
  return digest.digest("hex");
}

export async function stageLadybugSources({ cacheDirectory, outputDirectory, manifest }) {
  const sourceReceipts = await verifyLadybugSourceCache({ cacheDirectory, manifest });
  await requireEmptyDirectory(outputDirectory);
  const bindingDirectory = resolve(outputDirectory, "lbug-0.18.0");
  const opensslDirectory = resolve(outputDirectory, "openssl-3.5.8");
  await mkdir(bindingDirectory);
  await mkdir(opensslDirectory);
  await extractTar({
    cwd: bindingDirectory,
    file: resolve(cacheDirectory, manifest.rustBinding.archive),
    preservePaths: false,
    strict: true,
    strip: 1,
  });
  await extractTar({
    cwd: opensslDirectory,
    file: resolve(cacheDirectory, manifest.openssl.archive),
    preservePaths: false,
    strict: true,
    strip: 1,
  });

  const buildScriptSha256 = await sha256File(resolve(bindingDirectory, "build.rs"));
  if (buildScriptSha256 !== manifest.rustBinding.buildScriptSha256) {
    throw new Error("staged lbug build.rs differs from the reviewed unmodified binding");
  }
  const embeddedTreeSha256 = await digestLadybugSourceTree(resolve(bindingDirectory, "lbug-src"));
  if (embeddedTreeSha256 !== manifest.core.embeddedTreeSha256) {
    throw new Error("staged embedded Ladybug core differs from the reviewed 0.18.0 tree");
  }

  const receipt = {
    schemaVersion: 1,
    sources: sourceReceipts,
    core: {
      version: manifest.core.version,
      commit: manifest.core.commit,
      embeddedTreeSha256,
    },
    rustBinding: {
      crate: manifest.rustBinding.crate,
      version: manifest.rustBinding.version,
      buildScriptSha256,
      patched: false,
    },
    openssl: { version: manifest.openssl.version, sha256: manifest.openssl.sha256 },
    extensions: [],
    nativeMode: manifest.build.nativeMode,
    distributionLicenseReceiptComplete: false,
  };
  await writeFile(resolve(outputDirectory, "source-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return { bindingDirectory, opensslDirectory, receipt };
}

function targetConfiguration(manifest, target) {
  const configuration = manifest.build.targets[target];
  if (!configuration) throw new Error(`unsupported Ladybug source-build target: ${target}`);
  if (configuration.supported !== true) {
    throw new Error(
      `Ladybug source-build target ${target} is blocked: ${configuration.blocker}`,
    );
  }
  return configuration;
}

export function createLadybugCargoEnvironment({ manifest, outputDirectory, target }) {
  targetConfiguration(manifest, target);
  const bindingDirectory = resolve(outputDirectory, "lbug-0.18.0");
  const opensslPrefix = resolve(outputDirectory, "openssl-prefix");
  const libraryDirectory = resolve(opensslPrefix, "lib");
  const environment = {
    CARGO_NET_OFFLINE: "true",
    CMAKE_PREFIX_PATH: opensslPrefix,
    LBUG_BUILD_FROM_SOURCE: "1",
    LBUG_SOURCE_DIR: resolve(bindingDirectory, "lbug-src"),
    LBUG_VERSION: manifest.rustBinding.version,
    LIBRARY_PATH: libraryDirectory,
    OPENSSL_DIR: opensslPrefix,
    OPENSSL_ROOT_DIR: opensslPrefix,
    OPENSSL_STATIC: "1",
    OPENSSL_USE_STATIC_LIBS: "TRUE",
    PKG_CONFIG_LIBDIR: resolve(libraryDirectory, "pkgconfig"),
    PKG_CONFIG_PATH: resolve(libraryDirectory, "pkgconfig"),
  };
  if (target.endsWith("-apple-darwin")) {
    environment.MACOSX_DEPLOYMENT_TARGET = manifest.build.minimumMacOSVersion;
  }
  return environment;
}

async function run(command, args, options) {
  await execFileAsync(command, args, { ...options, maxBuffer: 16 * 1024 * 1024 });
}

async function relativeFiles(root, directory = root, output = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await relativeFiles(root, path, output);
    else if (entry.isFile()) output.push(relative(root, path).replaceAll("\\", "/"));
  }
  return output;
}

export async function buildPinnedOpenSsl({ jobs, manifest, outputDirectory, target }) {
  const configuration = targetConfiguration(manifest, target);
  const sourceDirectory = resolve(outputDirectory, "openssl-3.5.8");
  const prefix = resolve(outputDirectory, "openssl-prefix");
  const opensslDirectory = resolve(outputDirectory, "openssl-config");
  const configureArguments = [
    "Configure",
    configuration.opensslConfigureTarget,
    "no-shared",
    "no-module",
    "no-tests",
    "no-apps",
    "no-docs",
    `--prefix=${prefix}`,
    `--openssldir=${opensslDirectory}`,
  ];
  if (target.endsWith("-apple-darwin")) {
    configureArguments.push(`-mmacosx-version-min=${manifest.build.minimumMacOSVersion}`);
  }
  const buildEnvironment = { ...process.env };
  if (target.endsWith("-apple-darwin")) {
    buildEnvironment.MACOSX_DEPLOYMENT_TARGET = manifest.build.minimumMacOSVersion;
  }
  await run("perl", configureArguments, { cwd: sourceDirectory, env: buildEnvironment });
  const buildArgs = configuration.buildTool === "make" ? [`-j${jobs ?? 4}`, "build_sw"] : [];
  await run(configuration.buildTool, buildArgs, { cwd: sourceDirectory, env: buildEnvironment });
  await run(configuration.buildTool, ["install_sw"], {
    cwd: sourceDirectory,
    env: buildEnvironment,
  });

  const suffix = target === "x86_64-pc-windows-msvc" ? ".lib" : ".a";
  const staticLibraries = ["libssl", "libcrypto"];
  const artifacts = [];
  for (const name of staticLibraries) {
    const path = resolve(prefix, "lib", `${name}${suffix}`);
    await stat(path);
    artifacts.push({ file: relative(outputDirectory, path).replaceAll("\\", "/"), sha256: await sha256File(path) });
  }
  const unexpectedSharedLibraries = (await relativeFiles(prefix)).filter(
    (file) => /(?:\.dylib|\.dll|\.so(?:\.|$))/u.test(file),
  );
  if (unexpectedSharedLibraries.length !== 0) {
    throw new Error(`static OpenSSL prefix contains shared libraries: ${unexpectedSharedLibraries.join(", ")}`);
  }
  const environment = createLadybugCargoEnvironment({ manifest, outputDirectory, target });
  await writeFile(resolve(outputDirectory, "cargo-build-env.json"), `${JSON.stringify({
    schemaVersion: 1,
    target,
    cargoArguments: ["build", "--locked", "--offline"],
    environment,
    environmentMustBeUnset: manifest.build.environmentMustBeUnset,
    artifacts,
    requiredRuntimeRpath: null,
  }, null, 2)}\n`);
  return { artifacts, environment };
}

function parseArguments(arguments_) {
  const [command, ...rest] = arguments_;
  const options = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  return options;
}

async function main(arguments_) {
  const options = parseArguments(arguments_);
  const manifest = await loadLadybugSourceManifest(options.manifest);
  const cacheDirectory = resolve(options.cache ?? "");
  if (!options.command || !options.cache) {
    throw new Error(
      "usage: prepare-ladybug-source.mjs <fetch|verify|stage|prepare> "
      + "--cache <dir> [--output <dir>] [--target <triple>]",
    );
  }
  if (options.command === "fetch") {
    console.log(JSON.stringify(await fetchLadybugSourceCache({ cacheDirectory, manifest }), null, 2));
    return;
  }
  if (options.command === "verify") {
    console.log(JSON.stringify(await verifyLadybugSourceCache({ cacheDirectory, manifest }), null, 2));
    return;
  }
  if (!options.output) throw new Error(`${options.command} requires --output`);
  const outputDirectory = resolve(options.output);
  const staged = await stageLadybugSources({ cacheDirectory, outputDirectory, manifest });
  if (options.command === "stage") {
    console.log(JSON.stringify(staged.receipt, null, 2));
    return;
  }
  if (options.command !== "prepare" || !options.target) {
    throw new Error("prepare requires --target <triple>");
  }
  const built = await buildPinnedOpenSsl({
    jobs: Number(options.jobs ?? 4),
    manifest,
    outputDirectory,
    target: options.target,
  });
  console.log(JSON.stringify({ receipt: staged.receipt, ...built }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
