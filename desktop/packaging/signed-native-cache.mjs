import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { inventory, packagingBuildEnvironment, packagingIdentity, runtimeBinaryNames } from "./build-cache.mjs";

export const signedCacheSchema = "relayer.signed-native-cache/v1";
export const signedWorkflow = ".github/workflows/desktop-signed-preview.yml";
export const signedRepository = "vishaltandale00/relayer-graphcomplete";
export const signedProfile = Object.freeze({ profile: "release", debug: "1", features: "default", target: "aarch64-apple-darwin" });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const captureDefault = (command, args) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();

export function signedCacheProducer(environment) {
  if (environment.GITHUB_REPOSITORY !== signedRepository || environment.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || environment.GITHUB_REF !== "refs/heads/main"
    || environment.GITHUB_WORKFLOW_REF !== `${signedRepository}/${signedWorkflow}@refs/heads/main`
    || !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? "")
    || !/^[1-9]\d*$/.test(environment.GITHUB_RUN_ID ?? "")
    || !/^[1-9]\d*$/.test(environment.GITHUB_RUN_ATTEMPT ?? "")) throw Error("not a trusted manual main candidate context");
  return { repository: signedRepository, workflow: signedWorkflow, sourceCommit: environment.GITHUB_SHA,
    runId: environment.GITHUB_RUN_ID, runAttempt: environment.GITHUB_RUN_ATTEMPT };
}

export async function signedNativeIdentity({ repositoryRoot, environment, target, command }) {
  if (target.key !== "macos-arm64" || target.rustTarget !== signedProfile.target) throw Error("unsupported signed native target");
  // Do not remove ambient profile overrides to obtain a hit. packagingIdentity
  // rejects all of them; the release builder alone adds the debug=1 setting.
  const base = await packagingIdentity({ repositoryRoot, cacheRoot: join(repositoryRoot, ".relayer/signed-native-cache-v1"), target, environment, command });
  command ??= (name, args) => execFileSync(name, args, { encoding: "utf8", env: packagingBuildEnvironment(environment) }).trim();
  const implementation = {};
  for (const path of ["desktop/release/build-release.mjs", "desktop/release/build-native-release.mjs", "desktop/release/telemetry-artifacts.mjs", signedWorkflow]) {
    implementation[path] = hash(await readFile(join(repositoryRoot, path)));
  }
  return hash(JSON.stringify({ schema: signedCacheSchema, base, implementation, ...signedProfile,
    dsymutil: command("dsymutil", ["--version"]), dwarfdump: command("/usr/bin/dwarfdump", ["--version"]) }));
}

export function signedArtifactName(identity, producer) {
  if (!/^[a-f0-9]{64}$/.test(identity)) throw Error("invalid signed native identity");
  return `relayer-signed-native-v1-${identity}-${producer.runId}-${producer.runAttempt}`;
}

function debugIdentity(output) {
  const matches = [...String(output).matchAll(/UUID:\s*([a-f0-9-]{36})\s*\(([^)]+)\)/gi)];
  if (matches.length !== 1 || matches[0][2] !== "arm64") throw Error("expected one arm64 native debug identity");
  return matches[0][1].toLowerCase();
}

export async function validateSignedPayload(payload, capture = captureDefault) {
  const files = await inventory(payload); // Reject all symlinks, including roots.
  const expected = runtimeBinaryNames.flatMap((name) => [name, `${name}.dSYM/Contents/Info.plist`, `${name}.dSYM/Contents/Resources/DWARF/${name}`]).sort();
  const optional = runtimeBinaryNames.map((name) => `${name}.dSYM/Contents/Resources/Relocations/aarch64/${name}.yml`);
  if (expected.some((path) => !files[path]) || Object.keys(files).some((path) => !expected.includes(path) && !optional.includes(path))) throw Error("signed native binary/dSYM inventory mismatch");
  for (const path of Object.keys(files)) {
    if ((await stat(join(payload, path))).size === 0 || files[path].executable !== runtimeBinaryNames.includes(path)) throw Error("signed native file size/mode mismatch");
  }
  const identities = {};
  for (const name of runtimeBinaryNames) {
    const binary = join(payload, name);
    const symbols = `${binary}.dSYM`;
    const id = debugIdentity(await capture("/usr/bin/dwarfdump", ["--uuid", binary]));
    if (id !== debugIdentity(await capture("/usr/bin/dwarfdump", ["--uuid", symbols]))) throw Error("native dSYM UUID mismatch");
    await capture("/usr/bin/dwarfdump", ["--verify", "--quiet", join(symbols, "Contents/Resources/DWARF", name)]);
    const units = await capture("/usr/bin/dwarfdump", ["--debug-info", "--recurse-depth=0", symbols]);
    if (!/DW_TAG_compile_unit\b/.test(units)) throw Error("native dSYM contains no compilation units");
    identities[name] = id;
  }
  return { files, identities };
}

export async function generateSignedSymbols(binary, destination, generate = promisify(execFile)) {
  const result = await generate("dsymutil", [binary, "-o", destination]);
  if (/warning|error|no debug symbols/i.test(`${result.stdout}\n${result.stderr}`)) throw Error("incomplete dSYM generation diagnostics");
}

export async function verifySignedSnapshot(artifact, capture) {
  const actual = await validateSignedPayload(artifact.payload, capture);
  if (JSON.stringify(actual.files) !== JSON.stringify(artifact.files)) throw Error("signed native snapshot hashes changed");
}

export async function copySignedSymbols(artifact, name, destination) {
  const prefix = `${name}.dSYM/`;
  const expected = Object.fromEntries(Object.entries(artifact.files).filter(([path]) => path.startsWith(prefix)).map(([path, value]) => [path.slice(prefix.length), value]));
  await cp(join(artifact.payload, `${name}.dSYM`), destination, { recursive: true });
  if (JSON.stringify(await inventory(destination)) !== JSON.stringify(expected)) throw Error("copied dSYM hashes changed");
}

export async function sealSignedNative({ directory, outputDirectory, identity, producer, generateSymbols = generateSignedSymbols, capture }) {
  await rm(directory, { recursive: true, force: true });
  const payload = join(directory, "payload");
  await mkdir(payload, { recursive: true });
  for (const name of runtimeBinaryNames) {
    await cp(join(outputDirectory, name), join(payload, name));
    await chmod(join(payload, name), 0o755);
    // Generate while all Cargo object files still exist, never from cached bare binaries.
    await generateSymbols(join(outputDirectory, name), join(payload, `${name}.dSYM`));
  }
  const { files, identities } = await validateSignedPayload(payload, capture);
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ schema: signedCacheSchema, identity, producer, ...signedProfile, files, identities }));
  return { payload, files };
}

export async function verifySignedNative({ directory, identity, producer, capture }) {
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(["manifest.json", "payload"])) throw Error("signed artifact root inventory mismatch");
  await inventory(directory);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const expected = { schema: signedCacheSchema, identity, producer, ...signedProfile };
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(manifest[key]) !== JSON.stringify(value)) throw Error(`signed artifact ${key} mismatch`);
  }
  const payload = join(directory, "payload");
  const actual = await validateSignedPayload(payload, capture);
  if (JSON.stringify(actual.files) !== JSON.stringify(manifest.files) || JSON.stringify(actual.identities) !== JSON.stringify(manifest.identities)) throw Error("signed artifact hashes/debug identities mismatch");
  return { payload, files: actual.files };
}

export async function installSignedNative(artifact, outputDirectory, capture) {
  await verifySignedSnapshot(artifact, capture);
  await mkdir(outputDirectory, { recursive: true });
  for (const name of runtimeBinaryNames) {
    await cp(join(artifact.payload, name), join(outputDirectory, name));
    const actual = (await inventory(join(outputDirectory, name)))[""];
    if (JSON.stringify(actual) !== JSON.stringify(artifact.files[name])) throw Error("installed binary hashes changed");
  }
}
