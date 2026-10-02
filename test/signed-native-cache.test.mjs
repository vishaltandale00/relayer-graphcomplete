import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { parse } from "yaml";
import { nativeFunctionInventory } from "../desktop/packaging/signed-native-symbols.mjs";
import { buildReleaseRustServers } from "../desktop/release/build-release.mjs";
import { generateSignedSymbols, installSignedNative, sealSignedNative, signedArtifactName, signedCacheProducer, signedNativeIdentity, signedRepository, signedWorkflow, verifySignedNative, preserveCompilerSymbols } from "../desktop/packaging/signed-native-cache.mjs";
import { extractSignedArchive, restoreSignedNative, validateSignedProducer } from "../desktop/packaging/signed-native-transport.mjs";

const roots = [];
const temporary = async () => { const root = await mkdtemp(join(tmpdir(), "signed-native-test-")); roots.push(root); return root; };
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const identity = "b".repeat(64);
const sha = "a".repeat(40);
const environment = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: signedRepository, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_WORKFLOW_REF: `${signedRepository}/${signedWorkflow}@refs/heads/main`, GITHUB_SHA: sha, GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2", GITHUB_TOKEN: "test-token", RELAYER_SIGNED_NATIVE_CACHE: "1" };
const producer = signedCacheProducer(environment);
const names = ["relayer-app-server", "relayer-graph-server"];
const capture = vi.fn(async (command, args) => {
  if (command === "dsymutil") return "triple: arm64-apple-darwin\nobjects:\n  - filename: '/gone/liblbug.a(native.o)'\n    symbols: [{sym: _native, binAddr: 4096, size: 16}]";
  if (command === "/usr/bin/nm") return "0000000000001000 T _native";
  if (args[0] === "--debug-aranges") return "Address Range Header: cu_offset = 0x00000000\n[0x1000, 0x1010)";
  if (args[0] === "--verify") return "verified";
  if (args[0] === "--debug-info") return "0x00000000: Compile Unit:\nDW_TAG_compile_unit\nDW_AT_language (DW_LANG_C_plus_plus)";
  return "UUID: 12345678-1234-1234-1234-123456789abc (arm64) fixture";
});
const symbols = async (_command, args) => {
  const directory = args.at(-1);
  const name = args[0].split("/").at(-1);
  await mkdir(join(directory, "Contents/Resources/DWARF"), { recursive: true });
  await mkdir(join(directory, "Contents/Resources/Relocations/aarch64"), { recursive: true });
  await writeFile(join(directory, "Contents/Resources/Relocations/aarch64", `${name}.yml`), "relocations");
  await writeFile(join(directory, "Contents/Info.plist"), "plist");
  await writeFile(join(directory, "Contents/Resources/DWARF", name), "DWARF data");
};
async function fixture() {
  const root = await temporary();
  const outputDirectory = join(root, "compiled");
  await mkdir(outputDirectory);
  for (const name of names) await writeFile(join(outputDirectory, name), machoFixture(), { mode: 0o755 });
  const directory = join(root, "artifact");
  const artifact = await sealSignedNative({ directory, outputDirectory, identity, producer, generateSymbols: (binary, destination) => symbols("dsymutil", [binary, "-o", destination]), capture });
  return { root, directory, outputDirectory, artifact, payload: artifact.payload };
}
function metadata() {
  const run = { id: 123, run_attempt: 2, head_sha: sha, repository: { full_name: signedRepository }, head_repository: { full_name: signedRepository }, path: signedWorkflow, event: "workflow_dispatch", head_branch: "main", status: "completed", conclusion: "success" };
  const artifact = { id: 99, name: signedArtifactName(identity, producer), expired: false, digest: `sha256:${"c".repeat(64)}`, workflow_run: { id: 123, head_sha: sha, head_branch: "main" } };
  const jobs = { jobs: [{ name: "Sign and notarize macos-arm64 Preview", status: "completed", conclusion: "success", run_attempt: 2 }] };
  return { run, artifact, jobs, identity };
}

test("signed inventory verifies all binary and dSYM bytes, modes and native identities before reuse", async () => {
  const f = await fixture();
  const options = { ...f, identity, producer, capture };
  expect(await verifySignedNative(options)).toEqual(f.artifact);
  for (const [path, value] of [[names[0], "corrupt"], [`${names[1]}.dSYM/Contents/Resources/DWARF/${names[1]}`, ""]]) {
    const original = await readFile(join(f.payload, path));
    await writeFile(join(f.payload, path), value);
    await expect(verifySignedNative(options)).rejects.toThrow();
    await writeFile(join(f.payload, path), original);
  }
  await chmod(join(f.payload, names[0]), 0o644);
  await expect(verifySignedNative(options)).rejects.toThrow("mode");
  await chmod(join(f.payload, names[0]), 0o755);
  await expect(verifySignedNative({ ...options, identity: "d".repeat(64) })).rejects.toThrow("identity");
  await expect(verifySignedNative({ ...options, producer: { ...producer, runAttempt: "3" } })).rejects.toThrow("producer");
  await expect(verifySignedNative({ ...options, capture: async () => "UUID: 12345678-1234-1234-1234-123456789abc (x86_64)" })).rejects.toThrow("arm64");
  await expect(verifySignedNative({ ...options, capture: async (command, args) => args.at(-1).endsWith(".dSYM") ? "UUID: 99999999-1234-1234-1234-123456789abc (arm64)" : capture(command, args) })).rejects.toThrow("UUID");
  await expect(verifySignedNative({ ...options, capture: async (command, args) => { if (args[0] === "--verify") throw Error("invalid DWARF"); return capture(command, args); } })).rejects.toThrow("DWARF");
  await symlink("/etc/hosts", join(f.payload, "extra"));
  await expect(verifySignedNative(options)).rejects.toThrow("symlink");
  await rm(join(f.payload, "extra"));
  await rm(join(f.payload, `${names[0]}.dSYM/Contents/Info.plist`));
  await expect(verifySignedNative(options)).rejects.toThrow("inventory");
});

test("producer trust is bound to API workflow, repo, main, successful attempt and immutable artifact", () => {
  const valid = metadata();
  expect(validateSignedProducer(valid)).toEqual(producer);
  for (const changed of [
    { event: "pull_request" }, { path: ".github/workflows/ci.yml" }, { head_branch: "feature" }, { conclusion: "failure" },
    { run_attempt: 3 }, { repository: { full_name: "attacker/repo" } }, { head_repository: { full_name: "attacker/repo" } },
  ]) expect(() => validateSignedProducer({ ...valid, run: { ...valid.run, ...changed } })).toThrow();
  for (const changed of [{ expired: true }, { digest: "" }, { name: "development-cache" }, { id: -1 }, { workflow_run: { id: 999 } }]) {
    expect(() => validateSignedProducer({ ...valid, artifact: { ...valid.artifact, ...changed } })).toThrow();
  }
  expect(() => validateSignedProducer({ ...valid, jobs: { jobs: [{ ...valid.jobs.jobs[0], run_attempt: 1 }] } })).toThrow();
  expect(() => signedCacheProducer({ ...environment, GITHUB_REF: "refs/pull/12/merge" })).toThrow();
});

async function zip(directory, archive) {
  execFileSync("python3", ["-c", "import pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],'w'); [z.write(p,p.relative_to(root)) for p in root.rglob('*') if p.is_file()]; z.close()", directory, archive]);
  return readFile(archive);
}

test("restore authenticates archive before extraction; rechecks provenance and payload; failures miss", async () => {
  const f = await fixture();
  const bytes = await zip(f.directory, join(f.root, "archive.zip"));
  const data = metadata();
  data.artifact.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith("/zip")) return new Response(bytes);
    const body = url.includes("/jobs?") ? data.jobs : url.endsWith("/runs/123") ? data.run : url.endsWith("/artifacts/99") ? data.artifact : { artifacts: [data.artifact] };
    return Response.json(body);
  };
  const options = { identity, directory: join(f.root, "restored"), environment, capture, fetchImpl, report: () => {} };
  expect((await restoreSignedNative(options)).payload).toBe(join(options.directory, "payload"));
  expect(requests.filter((url) => url.endsWith("/runs/123"))).toHaveLength(2);
  const pages = [];
  const unrelated = Array.from({ length: 100 }, (_, id) => ({ id: id + 1000, name: "unrelated-ci-output" }));
  const paginatedFetch = async (url) => {
    if (url.includes("/artifacts?")) {
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(page);
      return Response.json({ total_count: 101, artifacts: page === 1 ? unrelated : [data.artifact] });
    }
    return fetchImpl(url);
  };
  expect((await restoreSignedNative({ ...options, fetchImpl: paginatedFetch })).payload).toBe(join(options.directory, "payload"));
  expect(pages).toEqual([1, 2]);
  const boundedLookup = vi.fn(async () => Response.json({ total_count: 10000, artifacts: unrelated }));
  expect(await restoreSignedNative({ ...options, fetchImpl: boundedLookup })).toBeNull();
  expect(boundedLookup).toHaveBeenCalledTimes(5);
  data.artifact.digest = `sha256:${"d".repeat(64)}`;
  const extract = vi.fn();
  expect(await restoreSignedNative({ ...options, extract })).toBeNull();
  expect(extract).not.toHaveBeenCalled();
  expect(await restoreSignedNative({ ...options, fetchImpl: async () => { throw Error("service unavailable"); } })).toBeNull();
  data.artifact.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  let runReads = 0;
  expect(await restoreSignedNative({ ...options, fetchImpl: async (url) => url.endsWith("/runs/123") && ++runReads === 2 ? Response.json({ ...data.run, run_attempt: 3 }) : fetchImpl(url) })).toBeNull();
});

test("archive extraction rejects traversal, links, duplicates, and unexpected files", async () => {
  const root = await temporary();
  for (const kind of ["traversal", "link", "duplicate", "extra"]) {
    const archive = join(root, `${kind}.zip`);
    execFileSync("python3", ["-c", `import sys,zipfile
z=zipfile.ZipFile(sys.argv[1], 'w'); kind=sys.argv[2]
names=['relayer-app-server','relayer-graph-server']; paths=['manifest.json']
for n in names: paths += ['payload/'+n,'payload/'+n+'.dSYM/Contents/Info.plist','payload/'+n+'.dSYM/Contents/Resources/DWARF/'+n]
for p in paths:
 i=zipfile.ZipInfo(p); i.external_attr=(0o120777 if kind=='link' else 0o100644)<<16; z.writestr(i,'data')
if kind!='link': z.writestr('../escape' if kind=='traversal' else 'manifest.json' if kind=='duplicate' else 'extra','x')
z.close()`, archive, kind], { stdio: "pipe" });
    expect(() => extractSignedArchive(archive, join(root, kind))).toThrow();
  }
});

test("real release build consumes verified hit, licenses, or compiles debug/locked/offline once on rejection", async () => {
  const f = await fixture();
  const license = vi.fn(async () => {});
  const prepare = vi.fn(async () => ({ environment: { OPENSSL_DIR: "/fixture/ssl", LBUG_SOURCE_DIR: "/fixture/lbug", OPENSSL_STATIC: "1", LBUG_BUILD_FROM_SOURCE: "1", CARGO_NET_OFFLINE: "true" } }));
  const execute = vi.fn(async (command, args) => {
    if (command === "dsymutil") return symbols(command, args);
    if (args[0] === "build") {
      const output = join(f.root, "target/aarch64-apple-darwin/release");
      await mkdir(output, { recursive: true });
      for (const name of names) await cp(join(f.outputDirectory, name), join(output, name));
    }
  });
  const options = { contract: { targetKey: "macos-arm64", rustTarget: "aarch64-apple-darwin", sourceCommit: sha }, repositoryRoot: f.root, environment, identify: async () => identity, restore: async () => f.artifact, generateSymbols: (binary, destination) => symbols("dsymutil", [binary, "-o", destination]), capture, verifyLadybugDistributionLicense: license, prepareLadybug: prepare, execute };
  const hitOutput = join(f.root, "hit-outputs");
  expect(await buildReleaseRustServers({ ...options, environment: { ...environment, GITHUB_OUTPUT: hitOutput } })).toBe(f.artifact);
  expect(await readFile(hitOutput, "utf8")).toContain("native_cache_outcome=verified-hit; native compilation skipped");
  expect(await readFile(hitOutput, "utf8")).not.toContain("native_artifact=");
  expect(license).toHaveBeenCalledOnce(); expect(prepare).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  await writeFile(join(f.payload, names[0]), "same UUID, changed executable bytes");
  await expect(installSignedNative(f.artifact, join(f.root, "install-rejected"), capture)).rejects.toThrow("hashes changed");
  const outputFile = join(f.root, "outputs");
  const fresh = await buildReleaseRustServers({ ...options, environment: { ...environment, GITHUB_OUTPUT: outputFile }, restore: async () => null });
  expect(fresh.payload).toContain("signed-native-cache-v1/payload");
  expect(execute.mock.calls.slice(0, 2).map((call) => call[1][0])).toEqual(["fetch", "build"]);
  expect(execute.mock.calls[1][1]).toEqual(["build", "--release", "-p", names[0], "-p", names[1], "--target", "aarch64-apple-darwin", "--locked", "--offline"]);
  expect(execute.mock.calls[1][2].env.CARGO_PROFILE_RELEASE_DEBUG).toBe("1");
  expect(execute.mock.calls[1][2].env.CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO).toBe("packed");
  expect(await readFile(outputFile, "utf8")).toContain(signedArtifactName(identity, producer));
  expect(await readFile(outputFile, "utf8")).toContain("native_cache_outcome=lookup-miss; compiling fresh");
  expect(await readFile(outputFile, "utf8")).toContain("native_cache_outcome=sealed; native artifact ready for upload");
  const fail = vi.fn(async (_command, args) => { if (args[0] === "build") throw Error("compiler failed"); });
  await expect(buildReleaseRustServers({ ...options, restore: async () => null, execute: fail })).rejects.toThrow("compiler failed");
  expect(fail).toHaveBeenCalledTimes(2);
  execute.mockClear();
  const failedOutput = join(f.root, "failed-outputs"), summary = join(f.root, "summary");
  expect(await buildReleaseRustServers({ ...options, environment: { ...environment, GITHUB_OUTPUT: failedOutput, GITHUB_STEP_SUMMARY: summary }, restore: async () => null, generateSymbols: async () => { throw Error("cache disk unavailable"); } })).toBeNull();
  expect(await readFile(failedOutput, "utf8")).toContain("native_cache_outcome=seal-failed; no native artifact upload");
  expect(await readFile(failedOutput, "utf8")).not.toContain("native_artifact=");
  expect(await readFile(summary, "utf8")).toContain("seal-failed; no native artifact upload");
  expect(execute.mock.calls.map((call) => call[1][0])).toEqual(["fetch", "build"]);
  execute.mockClear();
  expect(await buildReleaseRustServers({ ...options, environment: { ...environment, RELAYER_SIGNED_NATIVE_CACHE: "0" } })).toBeNull();
  expect(execute.mock.calls.map((call) => call[1][0])).toEqual(["fetch", "build"]);
  await expect(buildReleaseRustServers({ ...options, verifyLadybugDistributionLicense: async () => { throw Error("license blocked"); } })).rejects.toThrow("license blocked");
});

test("signed identity separates development profile and binds source, symbol tools and release implementation", async () => {
  const root = await temporary();
  for (const path of ["vendor/ladybug", "scripts/ci", "desktop/packaging", "desktop/shared", "desktop/release", "crates/core", ".cargo", "docs", "fixtures/graph-query-v1", ".github/workflows"]) await mkdir(join(root, path), { recursive: true });
  for (const path of ["scripts/prepare-ladybug-source.mjs", "scripts/verify-ladybug-native-receipts.mjs", "desktop/shared/target.mjs", "Cargo.toml", "Cargo.lock", "docs/graph-query-v1.md", "crates/core/lib.rs", "desktop/release/build-release.mjs", "desktop/release/telemetry-artifacts.mjs", signedWorkflow]) await writeFile(join(root, path), path);
  await writeFile(join(root, "scripts/ci/packaging-input-contract.json"), JSON.stringify({ version: 1, reviewedBuildConfiguration: {} }));
  const command = (name, args) => args[0] === "metadata" ? JSON.stringify({ packages: [] }) : name;
  const options = { repositoryRoot: root, target: { key: "macos-arm64", rustTarget: "aarch64-apple-darwin" }, environment: { HOME: root }, command };
  const first = await signedNativeIdentity(options);
  for (const path of ["crates/core/lib.rs", "desktop/packaging/signed-native-transport.mjs", "desktop/packaging/signed-native-symbols.mjs", "desktop/release/build-release.mjs", "desktop/release/telemetry-artifacts.mjs", signedWorkflow]) {
    const original = await readFile(join(root, path)).catch(() => null);
    await writeFile(join(root, path), "changed");
    expect(await signedNativeIdentity(options)).not.toBe(first);
    if (original) await writeFile(join(root, path), original);
    else await rm(join(root, path));
  }
  expect(await signedNativeIdentity({ ...options, command: (name, args) => name === "dsymutil" ? "updated symbol tool" : command(name, args) })).not.toBe(await signedNativeIdentity(options));
  await expect(signedNativeIdentity({ ...options, environment: { HOME: root, CARGO_PROFILE_RELEASE_DEBUG: "0" } })).rejects.toThrow("custom build inputs");
});

test("workflow retains source/signing/publication gates and uploads only separate optional native output", async () => {
  const workflow = parse(await readFile(resolve(import.meta.dirname, "../.github/workflows/desktop-signed-preview.yml"), "utf8"));
  const steps = workflow.jobs["package-macos"].steps;
  const build = steps.find((step) => step.id === "signed-build");
  expect(build.env.RELAYER_SIGNED_NATIVE_CACHE).toBe("1");
  expect(build.env.RELAYER_DESKTOP_SOURCE_COMMIT).toBe("${{ github.sha }}");
  const upload = steps.find((step) => step.name === "Preserve verified signed-profile native build output");
  expect(upload["continue-on-error"]).toBe(true);
  const report = steps.find((step) => step.name === "Report signed native cache upload");
  expect(report.if).toBe("always()");
  expect(report.env.ARTIFACT_ID).toContain("steps.native-upload.outputs.artifact-id");
  expect(report.env.ARTIFACT_DIGEST).toContain("steps.native-upload.outputs.artifact-digest");
  expect(report.env.UPLOAD_OUTCOME).toContain("steps.native-upload.outcome");
  expect(upload.with["include-hidden-files"]).toBe(true);
  expect(upload.with.path).toBe("${{ steps.signed-build.outputs.native_directory }}");
  expect(workflow.jobs.validate.steps.some((step) => step.run === "node desktop/release/main-ci-check.mjs")).toBe(true);
  expect(workflow.jobs["publish-preview-macos"].steps.some((step) => step.run?.includes("desktop:dist"))).toBe(false);
});

test("telemetry uses complete cached symbols and current release sources; packaged mismatch still fails", async () => {
  const { prepareDesktopTelemetryArtifacts } = await import("../desktop/release/telemetry-artifacts.mjs");
  const f = await fixture();
  const app = join(f.root, "desktop/dist/mac-arm64/Relayer.app");
  const source = "desktop/renderer/src/cache-proof.js";
  const packaged = join(app, "Contents/Resources");
  await mkdir(join(f.root, "desktop/renderer/src"), { recursive: true });
  await mkdir(join(packaged, "renderer/src"), { recursive: true });
  await mkdir(join(packaged, "bin"));
  await writeFile(join(f.root, source), "export const current = true;");
  await cp(join(f.root, source), join(packaged, "renderer/src/cache-proof.js"));
  for (const name of names) await cp(join(f.outputDirectory, name), join(packaged, "bin", name));
  const execute = vi.fn(async () => { throw Error("cached binary must not need original Cargo objects"); });
  const options = { contract: { release: true, version: "0.2.32", sourceCommit: "e".repeat(40), targetKey: "macos-arm64", platform: "darwin", distributionPlatform: "macos", architecture: "arm64", rustTarget: "aarch64-apple-darwin", channelName: "preview" }, repositoryRoot: f.root, packagedApplication: app, nativeDebugArtifacts: f.artifact, sourceGroups: [["renderer", source]], rustBinaries: names.map((name) => join(f.outputDirectory, name)), execute, capture: async (command, args) => ({ stdout: await capture(command, args) }) };
  const result = await prepareDesktopTelemetryArtifacts(options);
  expect(result.sourceCommit).toBe("e".repeat(40));
  expect(result.nativeDebugIdentities).toHaveLength(2);
  expect(result.debugArtifacts).toHaveLength(6);
  expect(execute).not.toHaveBeenCalled();
  for (const name of names) await cp(join(f.payload, `${name}.dSYM`), join(f.outputDirectory, `${name}.dSYM`), { recursive: true });
  const uncached = await prepareDesktopTelemetryArtifacts({ ...options, nativeDebugArtifacts: undefined, outputRoot: join(f.root, "uncached-telemetry") });
  expect(uncached.nativeDebugIdentities).toHaveLength(2);
  expect(execute).not.toHaveBeenCalled();
  await expect(prepareDesktopTelemetryArtifacts({ ...options, nativeDebugArtifacts: undefined, outputRoot: join(f.root, "incomplete-telemetry"),
    capture: async (command, args) => ({ stdout: args[0] === "--debug-aranges" ? "" : await capture(command, args) }),
  })).rejects.toThrow("incomplete native symbol coverage");
  expect(execute).not.toHaveBeenCalled();
  await expect(prepareDesktopTelemetryArtifacts({ ...options, capture: async (command, args) => ({ stdout: args.at(-1).includes("Relayer.app/Contents/Resources/bin") ? "UUID: 99999999-1234-1234-1234-123456789abc (arm64)" : await capture(command, args) }) })).rejects.toThrow("UUID");
});


test("successful dsymutil exit with incomplete-generation diagnostics cannot seal symbols", async () => {
  await expect(generateSignedSymbols("binary", "symbols", async () => ({ stdout: "", stderr: "warning: unable to open object file" }))).rejects.toThrow("incomplete dSYM");
});


test("matching UUID and valid Rust DWARF cannot hide missing or partial native coverage", async () => {
  const f = await fixture();
  for (const ranges of ["", "Address Range Header: cu_offset = 0x00000000\n[0x1000, 0x1008)"]) {
    await expect(verifySignedNative({ ...f, identity, producer, capture: (command, args) => args[0] === "--debug-aranges" ? ranges : capture(command, args) })).rejects.toThrow("incomplete native symbol coverage");
  }
  await expect(verifySignedNative({ ...f, identity, producer, capture: (command, args) => args[0] === "--debug-info" ? "0x00000000: Compile Unit:\nDW_TAG_compile_unit\nDW_AT_language (DW_LANG_Rust)" : capture(command, args) })).rejects.toThrow("incomplete native symbol coverage");

});

test("symbol tool failures preserve bounded first diagnostics and redact URLs", async () => {
  await expect(generateSignedSymbols("/tmp/server", "symbols", async () => { throw Object.assign(Error("exit 1"), { stderr: "missing liblbug.a(member.o) https://secret.example/token", stdout: "first diagnostic" }); })).rejects.toThrow("server: first diagnostic\nmissing liblbug.a(member.o) [redacted URL]");
  await expect(generateSignedSymbols("server", "symbols", async () => ({stdout: "", stderr: "warning: missing liblbug.a(member.o)"}))).rejects.toThrow("missing liblbug.a(member.o)");
});

function machoFixture() {
  const strings = Buffer.from("\0/gone/liblbug.a(native.o)\0_native\0");
  const bytes = Buffer.alloc(56 + 3 * 16 + strings.length);
  bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(24, 20);
  bytes.writeUInt32LE(2, 32); bytes.writeUInt32LE(24, 36);
  bytes.writeUInt32LE(56, 40); bytes.writeUInt32LE(3, 44);
  bytes.writeUInt32LE(104, 48); bytes.writeUInt32LE(strings.length, 52);
  bytes.writeUInt32LE(1, 56); bytes[60] = 0x66;
  bytes.writeUInt32LE(strings.indexOf(Buffer.from("_native")), 72); bytes[76] = 0x24; bytes.writeBigUInt64LE(4096n, 80);
  bytes[92] = 0x24; bytes.writeBigUInt64LE(16n, 96);
  strings.copy(bytes, 104); return bytes;
}


test("compiler symbols normalize only owned Cargo links; escapes and symbol links fail closed", async () => {
  const root = await temporary(), binary = join(root, "relayer-app-server");
  await mkdir(join(root, "deps"));
  const compiler = join(root, "deps/relayer_app_server-abc123.dSYM");
  await symbols("dsymutil", [binary, "-o", compiler]);
  await symlink("deps/relayer_app_server-abc123.dSYM", `${binary}.dSYM`);
  const destination = join(root, "copied.dSYM");
  await preserveCompilerSymbols(binary, destination);
  expect(await readFile(join(destination, "Contents/Resources/DWARF/relayer-app-server"), "utf8")).toBe("DWARF data");
  await rm(`${binary}.dSYM`); await symlink(compiler, `${binary}.dSYM`);
  await symlink("/etc/hosts", join(compiler, "extra"));
  await expect(preserveCompilerSymbols(binary, destination)).rejects.toThrow("symlink");
  await rm(`${binary}.dSYM`); await symlink("/tmp/untrusted.dSYM", `${binary}.dSYM`);
  await expect(preserveCompilerSymbols(binary, destination)).rejects.toThrow("escapes Cargo output");
});


test("embedded native map rejects malformed headers, bounds, strings and unterminated functions", () => {
  expect(nativeFunctionInventory(machoFixture())).toEqual([{ object: "/gone/liblbug.a(native.o)", name: "_native", low: 4096n, high: 4112n }]);
  for (const change of [
    (bytes) => bytes.writeUInt32LE(0, 0),
    (bytes) => bytes.writeUInt32LE(0xffffffff, 20),
    (bytes) => bytes.writeUInt32LE(4, 36),
    (bytes) => bytes.writeUInt32LE(0xffffffff, 44),
    (bytes) => bytes.writeUInt32LE(0xffffffff, 56),
    (bytes) => { bytes[92] = 0x66; },
    (bytes) => bytes.writeBigUInt64LE(0n, 96),
    (bytes) => { bytes[bytes.length - 1] = 1; },
  ]) { const bytes = machoFixture(); change(bytes); expect(() => nativeFunctionInventory(bytes)).toThrow("debug-map inventory"); }
});
