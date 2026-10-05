import { test, expect, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { WINDOWS_NATIVE_PROFILE, windowsNativeIdentity } from "../desktop/release/windows-native-identity.mjs";
import { WINDOWS_NATIVE_FILES, windowsNativeArtifactName, sealWindowsNative, verifyWindowsNativeBundle, installWindowsNative, validateWindowsNativeProducer, restoreWindowsNative, extractWindowsNativeArchive } from "../desktop/release/windows-native-cache.mjs";
import { qualifyWindowsNative, windowsCompilerEnvironment, adoptQualifiedWindowsNative } from "../desktop/release/windows-native-build.mjs";
import { loadDesktopReleaseContract } from "../desktop/release/contract.mjs";
import { buildReleaseNativeInputs } from "../desktop/release/build-release.mjs";
import { buildReleaseRustServers } from "../desktop/release/build-native-release.mjs";

const execute = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const roots = [];
const source = "a".repeat(40);
const identity = "b".repeat(64);
const producer = { runId: 10, runAttempt: 2, sourceCommit: source };
const guid = "12345678-1234-1234-1234-123456789abc";
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await mkdtemp(join(tmpdir(), "windows-native-cache-test-")); roots.push(root); return root; }
function executable(machine = 0x8664) {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ"); bytes.writeUInt32LE(64, 0x3c); bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(machine, 68); bytes.writeUInt16LE(240, 84); bytes.writeUInt16LE(0x20b, 88);
  bytes.writeUInt32LE(512, 148); bytes.writeUInt32LE(16, 196);
  return bytes;
}
const capture = vi.fn(async (name, args) => ({ stdout: `${name === "llvm-readobj" ? "PDBGUID" : "Guid"}: {${guid}}\n${name === "llvm-readobj" ? "PDBAge" : "Age"}: 3\n`, stderr: "" }));
async function outputs(directory) {
  await mkdir(directory, { recursive: true });
  for (const name of WINDOWS_NATIVE_FILES) await writeFile(join(directory, name), name.endsWith(".exe") ? executable() : `MSF fixture ${name}`);
}
function proof(binarySha256) { return { scope: "windows-release-profile-packaged-lifecycle/v1", sourceCommit: source, profile: WINDOWS_NATIVE_PROFILE,
  buildMode: "fresh-cargo-release-build", binarySha256, cleanProfileCreated: true, lockContentionRejected: true, cleanShutdown: true, restartReopenedPersistedMarker: true, storageVersion: 42 }; }
async function fixture() {
  const root = await temporary(); const output = join(root, "native"); await outputs(output);
  const binarySha256 = Object.fromEntries(await Promise.all(["relayer-app-server.exe", "relayer-graph-server.exe"].map(async name => [name, hash(await readFile(join(output, name)))])));
  const bundle = await sealWindowsNative({ directory: join(root, "bundle"), outputDirectory: output, identity, producer, qualification: proof(binarySha256), capture });
  return { root, output, bundle };
}
function metadata() {
  const run = { id: 10, run_attempt: 2, head_sha: source, head_branch: "main", repository: { full_name: "vishaltandale00/relayer-graphcomplete" }, head_repository: { full_name: "vishaltandale00/relayer-graphcomplete" }, event: "workflow_dispatch", path: ".github/workflows/desktop-windows-candidate.yml", status: "completed", conclusion: "failure" };
  const job = (name, steps) => ({ name, status: "completed", conclusion: "success", run_id: 10, run_attempt: 2, head_sha: source, labels: [name === "validate" ? "ubuntu-latest" : "windows-2025"], steps: steps.map(name => ({ name, conclusion: "success" })) });
  const jobs = { jobs: [job("validate", ["Require protected main source", "Require exact-source main CI"]), job("Qualify Windows native package", ["Qualify release native inputs once", "Preserve qualified Windows native inputs"])] };
  const artifact = { id: 99, name: windowsNativeArtifactName(identity, producer), expired: false, digest: `sha256:${"c".repeat(64)}`, workflow_run: { id: 10, head_sha: source, head_branch: "main" } };
  return { run, jobs, artifact };
}
async function archive(root, directory, extra = null) {
  const path = join(root, "native.zip");
  await execute(process.platform === "win32" ? "python" : "python3", ["-I", "-c", "import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:\n for f in sorted(p.rglob('*')):\n  if f.is_file():z.write(f,f.relative_to(p).as_posix())\n if len(sys.argv)>3:z.writestr(sys.argv[3],b'extra')", directory, path, ...(extra ? [extra] : [])]);
  return { path, bytes: await readFile(path) };
}
async function networkFixture(f, options = {}) {
  const zip = await archive(f.root, f.bundle.directory);
  const data = metadata(); data.artifact.digest = `sha256:${hash(zip.bytes)}`;
  const fetchImpl = vi.fn(async url => {
    if (url.endsWith("/zip")) return new Response(options.corrupt ? Buffer.from("corrupt") : zip.bytes);
    if (url.includes("/artifacts?")) return Response.json({ total_count: 1, artifacts: [data.artifact] });
    if (url.endsWith("/artifacts/99")) return Response.json(data.artifact);
    if (url.includes("/jobs?")) return Response.json(data.jobs);
    if (url.endsWith("/runs/10")) return Response.json(data.run);
    throw Error(`unexpected metadata request: ${url}`);
  });
  return { ...data, fetchImpl, zip };
}

test("native bundle authenticates all four real file hashes, both PE architectures and EXE/PDB correlation", async () => {
  const f = await fixture();
  const options = { directory: f.bundle.directory, identity, producer, capture };
  expect((await verifyWindowsNativeBundle(options)).manifest.qualification.cleanShutdown).toBe(true);
  await installWindowsNative(f.bundle, join(f.root, "installed"), { capture });
  for (const name of WINDOWS_NATIVE_FILES) expect(hash(await readFile(join(f.root, "installed", name)))).toBe(f.bundle.manifest.files[name].sha256);
  await writeFile(join(f.bundle.payload, "relayer_app_server.pdb"), "modified symbols");
  await expect(verifyWindowsNativeBundle(options)).rejects.toThrow("native payload hashes differ");
  await outputs(f.output);
  await writeFile(join(f.output, "relayer-graph-server.exe"), executable(0xaa64));
  await expect(sealWindowsNative({ ...options, outputDirectory: f.output, qualification: f.bundle.manifest.qualification })).rejects.toThrow("must be x64");
});

test("PDB mismatch and failed lifecycle cannot supply a qualified native bundle", async () => {
  const f = await fixture();
  const mismatched = async (name) => ({ stdout: `GUID: ${guid}\nAge: ${name === "llvm-readobj" ? 3 : 4}\n` });
  await expect(verifyWindowsNativeBundle({ directory: f.bundle.directory, identity, producer, capture: mismatched })).rejects.toThrow("PDB identity");
  const manifest = { ...f.bundle.manifest, qualification: { ...f.bundle.manifest.qualification, restartReopenedPersistedMarker: false } };
  await writeFile(join(f.bundle.directory, "manifest.json"), JSON.stringify(manifest));
  await expect(verifyWindowsNativeBundle({ directory: f.bundle.directory, identity, producer, capture })).rejects.toThrow();
});

test("successful manual-main native producers remain usable after downstream failure while PR/source/job/attempt mismatches reject", () => {
  const data = metadata();
  expect(validateWindowsNativeProducer({ ...data, identity })).toEqual(producer);
  for (const change of [run => { run.event = "pull_request"; }, run => { run.head_branch = "feature"; }, run => { run.run_attempt = 3; }, run => { run.repository.full_name = "other/repo"; }]) {
    const next = structuredClone(data); change(next.run);
    expect(() => validateWindowsNativeProducer({ ...next, identity })).toThrow();
  }
  const next = structuredClone(data); next.jobs.jobs[1].steps[0].conclusion = "failure";
  expect(() => validateWindowsNativeProducer({ ...next, identity })).toThrow("Qualify release native inputs once");
  expect(() => validateWindowsNativeProducer({ ...data, identity, expected: { ...producer, sourceCommit: "d".repeat(40) } })).toThrow("current candidate");
});

test("real ZIP handoff requires authenticated digest and producer; optional corruption misses, required corruption fails closed", async () => {
  const f = await fixture(); const net = await networkFixture(f);
  const options = { identity, directory: join(f.root, "restored"), environment: { GITHUB_TOKEN: "synthetic" }, capture, fetchImpl: net.fetchImpl, report: () => {} };
  expect((await restoreWindowsNative(options)).artifactId).toBe(99);
  expect((await restoreWindowsNative({ ...options, expected: producer })).manifest.producer).toEqual(producer);
  const corrupt = await networkFixture(f, { corrupt: true });
  expect(await restoreWindowsNative({ ...options, fetchImpl: corrupt.fetchImpl })).toBeNull();
  await expect(restoreWindowsNative({ ...options, fetchImpl: corrupt.fetchImpl, expected: producer })).rejects.toThrow("digest mismatch");
});

test("fixed archive inventory rejects traversal, backslashes, case duplicates and extra payloads before extraction", async () => {
  for (const path of ["../outside", "payload\\relayer-app-server.exe", "payload/RELAYER-APP-SERVER.EXE", "payload/extra.exe"]) {
    const f = await fixture(); const zip = await archive(f.root, f.bundle.directory, path);
    const destination = join(f.root, "unpack"); await mkdir(destination);
    await expect(extractWindowsNativeArchive(zip.path, destination)).rejects.toThrow("unexpected native archive inventory");
  }
});

test("producer rerun during download invalidates required handoff", async () => {
  const f = await fixture(); const net = await networkFixture(f); let reads = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/runs/10") && ++reads > 1) return Response.json({ ...net.run, run_attempt: 3 });
    return net.fetchImpl(url, options);
  };
  await expect(restoreWindowsNative({ identity, directory: join(f.root, "changed-attempt"), environment: { GITHUB_TOKEN: "synthetic" }, capture, fetchImpl, expected: producer })).rejects.toThrow();
});

test("Windows identity preserves renderer/version/workflow-only reuse and separates native, Rust, SDK and override changes", async () => {
  const root = await temporary();
  const dirs = ["vendor/ladybug", "desktop/packaging", "desktop/shared", "desktop/release", "scripts/ci", "crates/core", ".cargo", "docs", "fixtures/graph-query-v1", "tools"];
  for (const path of dirs) await mkdir(join(root, path), { recursive: true });
  for (const path of ["vendor/ladybug/manifest.json", "scripts/prepare-ladybug-source.mjs", "scripts/verify-ladybug-native-receipts.mjs", "desktop/packaging/pinned-ladybug-build.mjs", "desktop/packaging/build-cache.mjs", "desktop/packaging/windows-native.mjs", "desktop/shared/target.mjs", "desktop/release/build-native-release.mjs", "desktop/release/windows-native-build.mjs", "desktop/release/windows-native-identity.mjs", "Cargo.toml", "Cargo.lock", "docs/graph-query-v1.md", "crates/core/lib.rs"]) await writeFile(join(root, path), path);
  await writeFile(join(root, "scripts/ci/packaging-input-contract.json"), JSON.stringify({ version: 1, reviewedBuildConfiguration: {} }));
  for (const tool of ["rustc", "cargo", "cl", "link", "cmake", "perl", "nmake", "llvm-readobj", "llvm-pdbutil"]) await writeFile(join(root, "tools", `${tool}.exe`), tool);
  const env = { CARGO_HOME: join(root, "cargo-home"), VCToolsVersion: "14.51", WindowsSDKVersion: "10.0.26100.0", Path: join(root, "tools"), RUNNER_TEMP: root };
  const capture = async (name, args) => ({ stdout: name === "where.exe" ? join(root, "tools", `${args[0]}.exe`) : args[0] === "metadata" ? JSON.stringify({ packages: [] }) : `${name} reviewed version`, stderr: "" });
  const options = { repositoryRoot: root, environment: env, capture, platform: "win32", architecture: "x64" };
  const first = await windowsNativeIdentity(options);
  await mkdir(join(root, "desktop/renderer")); await writeFile(join(root, "desktop/renderer/ui.js"), "new UI");
  await writeFile(join(root, "desktop/windows-version.json"), "new version");
  expect(await windowsNativeIdentity(options)).toEqual(first);
  await writeFile(join(root, "crates/core/lib.rs"), "changed Rust");
  const rust = await windowsNativeIdentity(options);
  expect(rust.runtime).not.toBe(first.runtime); expect(rust.native).toBe(first.native); expect(rust.dependency).toBe(first.dependency);
  await writeFile(join(root, "vendor/ladybug/manifest.json"), "changed native");
  expect((await windowsNativeIdentity(options)).native).not.toBe(first.native);
  expect((await windowsNativeIdentity({ ...options, environment: { ...env, WindowsSDKVersion: "other SDK" } })).native).not.toBe(rust.native);
  await expect(windowsNativeIdentity({ ...options, environment: { ...env, rustflags: "-C opt-level=0" } })).rejects.toThrow("unsupported Windows");
  await expect(windowsNativeIdentity({ ...options, environment: { ...env, PATH: "different" } })).rejects.toThrow("ambiguous Windows");
  for (const name of ["CL", "_cl_", "LINK", "PERL5OPT", "CARGO_INCREMENTAL"]) await expect(windowsNativeIdentity({ ...options, environment: { ...env, [name]: "custom compiler input" } })).rejects.toThrow("unsupported Windows");
  await writeFile(join(root, "crates/core/build.rs"), "unreviewed external input");
  await expect(windowsNativeIdentity(options)).rejects.toThrow("unreviewed build script");
});

test("pinned compiler cache setup failure falls back without suppressing actual compiler execution", async () => {
  const env = { SCCACHE_PATH: "/official/sccache.exe", RUNNER_TEMP: "/temporary" };
  const enabled = await windowsCompilerEnvironment(env, { capture: async () => ({ stdout: "sccache 0.18.0" }), report: () => {} });
  expect(enabled.RUSTC_WRAPPER).toBe(env.SCCACHE_PATH); expect(enabled.CMAKE_CXX_COMPILER_LAUNCHER).toBe(env.SCCACHE_PATH);
  expect(enabled.CARGO_INCREMENTAL).toBe("0"); expect(enabled.SCCACHE_IGNORE_SERVER_IO_ERROR).toBe("1");
  const direct = await windowsCompilerEnvironment(env, { capture: async () => { throw Error("cache service unavailable"); }, report: () => {} });
  expect(direct.RUSTC_WRAPPER).toBeUndefined(); expect(direct.CARGO_INCREMENTAL).toBe("0");
});

test("real release builder compiles once on miss, fresh qualification runs on hit, and compiler failure is never retried", async () => {
  const f = await fixture();
  const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "vishaltandale00/relayer-graphcomplete", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_JOB: "qualify", GITHUB_RUN_ID: "10", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: source, RUNNER_TEMP: f.root };
  const directory = join(f.root, "target", WINDOWS_NATIVE_PROFILE.target, "release");
  const lifecycle = vi.fn(async () => ({ cleanProfileCreated: true, lockContentionRejected: true, cleanShutdown: true, restartReopenedPersistedMarker: true, storageVersion: 42 }));
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push({ command, args, env: options.env });
    if (command === "cargo" && args[0] === "build") await outputs(directory);
    if (args.includes("--dir")) {
      const resources = join(f.root, "desktop/dist/win-unpacked/resources/bin"); await mkdir(resources, { recursive: true });
      for (const name of ["relayer-app-server.exe", "relayer-graph-server.exe"]) await cp(join(directory, name), join(resources, name));
    }
  };
  const requireLicense = vi.fn(async () => {});
  const buildNative = options => buildReleaseRustServers({ ...options, verifyLadybugDistributionLicense: requireLicense });
  const plan = { identity: { runtime: identity, native: "e".repeat(64), cacheEligible: true }, producer };
  const options = { plan, repositoryRoot: f.root, environment: env, execute, buildNative, lifecycle, requireLicense, capture, verifySource: async () => {}, prepareLadybug: async () => ({ environment: { OPENSSL_DIR: f.root, LBUG_SOURCE_DIR: f.root, OPENSSL_STATIC: "1", LBUG_BUILD_FROM_SOURCE: "1", CARGO_NET_OFFLINE: "true" }, environmentMustBeUnset: [], dispose: async () => {} }) };
  const fresh = await qualifyWindowsNative(options);
  const compilation = calls.filter(call => call.command === "cargo" && call.args[0] === "build");
  expect(compilation).toHaveLength(1); expect(compilation[0].args).toContain("--locked"); expect(compilation[0].args).toContain("--offline"); expect(compilation[0].env.CARGO_PROFILE_RELEASE_DEBUG).toBe("1");
  expect(fresh.manifest.qualification.buildMode).toBe("fresh-cargo-release-build");
  const old = await fixture(); calls.length = 0;
  const hit = await qualifyWindowsNative({ ...options, restoredBundle: { ...old.bundle, artifactId: 99, artifactDigest: "authenticated" } });
  expect(calls.some(call => call.command === "cargo")).toBe(false); expect(lifecycle).toHaveBeenCalledTimes(2);
  expect(hit.manifest.qualification.buildMode).toBe("verified-native-artifact");
  let failedBuilds = 0;
  await expect(qualifyWindowsNative({ ...options, execute: async (command, args) => { if (command === "cargo" && args[0] === "build") { failedBuilds++; throw Error("real compiler failure"); } } })).rejects.toThrow("real compiler failure");
  expect(failedBuilds).toBe(1);
});

test("Windows workflow builds in unprivileged qualification, adopts before login and isolates optional caches from main/macOS", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/desktop-windows-candidate.yml", import.meta.url), "utf8"));
  expect(workflow.jobs.qualify.permissions["id-token"]).toBeUndefined(); expect(workflow.jobs.qualify.environment).toBeUndefined();
  expect(workflow.jobs.qualify.outputs.native_identity).toBe("${{ steps.native-plan.outputs.identity }}");
  // GitHub evaluates job env before routing to a runner. Runtime paths must
  // reach subsequent actions/processes through GITHUB_ENV instead.
  expect(Object.values(workflow.jobs.qualify.env).join("\n")).not.toContain("runner.");
  const initialize = workflow.jobs.qualify.steps[0];
  expect(initialize.shell).toBe("pwsh");
  for (const value of ["TEMP=$env:RUNNER_TEMP", "TMP=$env:RUNNER_TEMP", "SCCACHE_DIR=$env:RUNNER_TEMP/rwc"]) {
    expect(initialize.run).toContain(`"${value}" >> $env:GITHUB_ENV`);
  }
  const steps = workflow.jobs.package.steps;
  const adopt = steps.findIndex(step => step.run === "node desktop/release/windows-native-build.mjs adopt");
  expect(adopt).toBeGreaterThan(-1); expect(steps.findIndex(step => step.uses?.startsWith("azure/login@"))).toBeGreaterThan(adopt);
  expect(steps.some(step => step.run?.includes("--prepare-windows-native"))).toBe(false);
  const optional = workflow.jobs.qualify.steps.filter(step => step.uses?.startsWith("actions/cache/"));
  expect(optional).toHaveLength(6);
  for (const step of optional) { expect(step["continue-on-error"]).toBe(true); expect(step.if).toContain("workflow_dispatch"); }
  for (const file of ["ci.yml", "desktop-signed-preview.yml"]) {
    const other = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"); expect(other).not.toContain("windows-native-build.mjs");
  }
});


test("required current-run native adoption installs authenticated bytes and release consumption never compiles", async () => {
  const f = await fixture(); const net = await networkFixture(f);
  await mkdir(join(f.root, "desktop"));
  await writeFile(join(f.root, "desktop/windows-version.json"), JSON.stringify({ version: "0.2.0" }));
  const environment = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "vishaltandale00/relayer-graphcomplete", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main", GITHUB_JOB: "package", GITHUB_RUN_ID: "10", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: source, GITHUB_TOKEN: "synthetic", RUNNER_TEMP: f.root,
    RELAYER_DESKTOP_UPDATE_BASE_URL: "https://updates.relayerlabs.ai/desktop/windows/x64", RELAYER_DESKTOP_RELEASE: "1", RELAYER_DESKTOP_CHANNEL: "preview", RELAYER_DESKTOP_TARGET: "windows-x64", RELAYER_DESKTOP_SOURCE_COMMIT: source,
    RELAYER_DESKTOP_CANDIDATE_RUN_ID: "10", RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: "2", RELAYER_WINDOWS_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/", RELAYER_WINDOWS_SIGNING_ACCOUNT: "relayercodesigning", RELAYER_WINDOWS_CERTIFICATE_PROFILE: "relayer-windows", RELAYER_WINDOWS_PUBLISHER_NAME: "CN=Relayer Labs LLC, O=Relayer Labs LLC, L=Lewes, S=Delaware, C=US" };
  const loadContract = options => loadDesktopReleaseContract({ ...options, execute: async (_command, args) => ({ stdout: args[0] === "rev-parse" ? source : "" }) });
  const receiptPath = join(f.root, "handoff.json");
  const restore = options => restoreWindowsNative({ ...options, fetchImpl: net.fetchImpl });
  const options = { repositoryRoot: f.root, environment, expectedIdentity: identity, receiptPath, capture, loadContract, restore };
  const previous = { ...net.artifact, id: 98, name: windowsNativeArtifactName(identity, { ...producer, runAttempt: 1 }) };
  const allAttempts = async (url, fetchOptions) => url.includes("/artifacts?") ? Response.json({ total_count: 2, artifacts: [previous, net.artifact] }) : net.fetchImpl(url, fetchOptions);
  await adoptQualifiedWindowsNative({ ...options, restore: input => restoreWindowsNative({ ...input, fetchImpl: allAttempts }) });
  const contract = await loadContract({ environment, desktopRoot: join(f.root, "desktop") });
  const compile = vi.fn(async () => { throw Error("unexpected compilation"); });
  const consume = { repositoryRoot: f.root, contract, environment, preparedWindowsNativeReceipt: receiptPath, buildNative: compile, requireLicense: async () => {} };
  expect(await buildReleaseNativeInputs(consume)).toBeNull(); expect(compile).not.toHaveBeenCalled();
  await writeFile(join(f.root, "target", WINDOWS_NATIVE_PROFILE.target, "release/relayer_app_server.pdb"), "tampered");
  await expect(buildReleaseNativeInputs(consume)).rejects.toThrow("EXE/PDB bytes");
  for (const changes of [{ GITHUB_JOB: "qualify" }, { GITHUB_RUN_ATTEMPT: "3", RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: "3" }]) await expect(adoptQualifiedWindowsNative({ ...options, environment: { ...environment, ...changes } })).rejects.toThrow();
  await expect(buildReleaseNativeInputs({ ...consume, contract: { ...contract, sourceCommit: "d".repeat(40) } })).rejects.toThrow("contract");
  await expect(adoptQualifiedWindowsNative({ ...options, restore: async () => null })).rejects.toThrow("handoff unavailable");
  expect(compile).not.toHaveBeenCalled();
});
