import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, lstat, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { inventory } from "../packaging/build-cache.mjs";

const execute = promisify(execFile);
const hash = value => createHash("sha256").update(value).digest("hex");
export const WINDOWS_NATIVE_PROFILE = Object.freeze({ target: "x86_64-pc-windows-msvc", profile: "release", debug: "1", features: "default", packages: ["relayer-app-server", "relayer-graph-server"] });

// These are compilation inputs, not the renderer, release version or current
// source commit. A compatible binary hit still requires fresh consumer proof.
const nativePaths = ["vendor/ladybug", "scripts/prepare-ladybug-source.mjs", "scripts/verify-ladybug-native-receipts.mjs", "desktop/packaging/pinned-ladybug-build.mjs", "desktop/packaging/build-cache.mjs", "desktop/packaging/windows-native.mjs", "desktop/shared/target.mjs", "scripts/ci/packaging-input-contract.json", "desktop/release/windows-native-build.mjs", "desktop/release/windows-native-identity.mjs"];
const runtimePaths = ["crates", "Cargo.toml", "Cargo.lock", ".cargo", "docs/graph-query-v1.md", "fixtures/graph-query-v1", "desktop/release/build-native-release.mjs"];

function normalizeEnvironment(environment) {
  const result = {};
  for (const [name, value] of Object.entries(environment)) {
    const key = name.toUpperCase();
    if (key in result && result[key] !== value) throw Error(`ambiguous Windows environment: ${key}`);
    result[key] = value;
  }
  return result;
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return false; throw error; }
}

export async function windowsNativeIdentity({ repositoryRoot, environment = process.env, platform = process.platform, architecture = process.arch, capture }) {
  if (platform !== "win32" || architecture !== "x64") throw Error("Windows native cache requires native Windows x64");
  const root = resolve(repositoryRoot);
  const env = normalizeEnvironment(environment);
  capture ??= async (name, args) => execute(name, args, { env: environment, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  const command = async (name, args) => {
    const result = await capture(name, args);
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  };
  // Compiler cache settings are introduced only after this identity is computed.
  // Arbitrary wrappers/flags/prefixes cannot turn an incompatible entry into a hit.
  const unsupported = Object.entries(env).filter(([name, value]) => value && /^(?:CL|_CL_|LINK|_LINK_|PERL5LIB|PERL5OPT|PERLLIB|CARGO_INCREMENTAL|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC|RUSTDOC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_TARGET_DIR|RELAYER_CARGO_TARGET_DIR|CARGO_BUILD_.+|CARGO_TARGET_.+|CARGO_PROFILE_.+|CC|CC_.+|CXX.*|CPP.*|CFLAGS.*|AR|AR_.+|LD|LD_.+|LDFLAGS.*|CMAKE_.+|OPENSSL_.+|LBUG_.+|PKG_CONFIG.*|SOURCE_DATE_EPOCH)$/.test(name));
  if (unsupported.length) throw Error(`unsupported Windows native build settings: ${unsupported.map(([name]) => name).join(", ")}`);
  const contract = JSON.parse(await readFile(join(root, "scripts/ci/packaging-input-contract.json"), "utf8"));
  if (contract.version !== 1 || !contract.reviewedBuildConfiguration) throw Error("unreviewed native input contract");
  const reviewed = contract.reviewedBuildConfiguration;
  for (const [path, expected] of Object.entries(reviewed)) {
    if (hash(await readFile(join(root, path))) !== expected) throw Error(`unreviewed native build configuration: ${path}`);
  }
  for (const crate of await readdir(join(root, "crates"))) {
    const path = `crates/${crate}/build.rs`;
    if (await exists(join(root, path)) && !reviewed[path]) throw Error(`unreviewed build script: ${path}`);
  }
  for (const name of ["config", "config.toml"]) {
    if (await exists(join(root, ".cargo", name)) && !reviewed[`.cargo/${name}`]) throw Error("unreviewed Cargo configuration");
    if (await exists(join(env.CARGO_HOME || join(homedir(), ".cargo"), name))) throw Error("ambient Cargo configuration");
    let ancestor = dirname(root);
    for (;;) {
      if (await exists(join(ancestor, ".cargo", name))) throw Error("ancestor Cargo configuration");
      const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
    }
  }
  const metadata = JSON.parse(await command("cargo", ["metadata", "--no-deps", "--locked", "--offline", "--format-version", "1", "--manifest-path", join(root, "Cargo.toml")]));
  const contained = path => resolve(path).toLowerCase().startsWith(`${resolve(root, "crates").toLowerCase()}${sep}`);
  for (const pkg of metadata.packages) {
    if (!contained(pkg.manifest_path)) throw Error("external workspace package requires native input review");
    for (const dependency of pkg.dependencies ?? []) if (dependency.path && !contained(dependency.path)) throw Error("external Cargo path dependency");
    for (const target of pkg.targets ?? []) {
      if (target.kind.includes("custom-build") && !reviewed[relative(root, target.src_path).replaceAll("\\", "/")]) throw Error("unreviewed custom build input");
    }
  }
  // Resolve actual tools through the admitted MSVC environment and hash them.
  const tools = {};
  for (const name of ["rustc", "cargo", "cl", "link", "cmake", "perl", "nmake", "llvm-readobj", "llvm-pdbutil"]) {
    const paths = (await command("where.exe", [name])).split(/\r?\n/).filter(Boolean);
    if (!paths.length) throw Error(`Windows native tool unavailable: ${name}`);
    const path = paths[0];
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw Error(`nonregular native tool: ${name}`);
    tools[name] = { path, sha256: hash(await readFile(path)) };
  }
  const toolVersions = {
    rustc: await command("rustc", ["-vV"]), cargo: await command("cargo", ["-V"]),
    cmake: await command("cmake", ["--version"]), perl: await command("perl", ["-V"]),
    llvm: await command("llvm-readobj", ["--version"]),
  };
  const selection = Object.fromEntries(["PATH", "INCLUDE", "LIB", "LIBPATH", "VCTOOLSINSTALLDIR", "VCTOOLSVERSION", "WINDOWSSDKDIR", "WINDOWSSDKVERSION", "UCRTVERSION", "UNIVERSALCRTSDKDIR"].map(name => [name, env[name] || ""]));
  if (!selection.VCTOOLSVERSION || !selection.WINDOWSSDKVERSION) throw Error("MSVC/Windows SDK identity unavailable");
  const inputs = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, await inventory(join(root, path))])));
  const machine = { root, nativeCacheRoot: join(env.RUNNER_TEMP || root, "rwn"), compilerCache: { implementation: "sccache", version: "0.18.0" }, platform, architecture, profile: WINDOWS_NATIVE_PROFILE, tools, toolVersions, selection };
  const native = hash(JSON.stringify({ schema: 1, machine, inputs: await inputs(nativePaths) }));
  const runtime = hash(JSON.stringify({ schema: 1, native, inputs: await inputs(runtimePaths) }));
  return { native, runtime, dependency: hash(JSON.stringify({ schema: 1, machine, cargoLock: hash(await readFile(join(root, "Cargo.lock"))) })), profile: WINDOWS_NATIVE_PROFILE };
}
