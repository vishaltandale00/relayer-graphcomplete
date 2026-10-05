import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { inventory } from "../packaging/build-cache.mjs";
import { verifyWindowsNativeExecutable } from "../packaging/windows-native.mjs";
import { windowsRustPdbPath, verifyWindowsRustDebugIdentity } from "./windows-rust-debug.mjs";
import { WINDOWS_NATIVE_PROFILE } from "./windows-native-identity.mjs";

const execute = promisify(execFile);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const WINDOWS_NATIVE_REPOSITORY = "vishaltandale00/relayer-graphcomplete";
export const WINDOWS_NATIVE_WORKFLOW = ".github/workflows/desktop-windows-candidate.yml";
export const WINDOWS_NATIVE_FILES = Object.freeze(["relayer-app-server.exe", "relayer-graph-server.exe", "relayer_app_server.pdb", "relayer_graph_server.pdb"].sort());
const binaries = ["relayer-app-server.exe", "relayer-graph-server.exe"];
const schema = "relayer.windows-release-native/v1";

export function windowsNativeProducer(environment) {
  const producer = { runId: Number(environment.GITHUB_RUN_ID), runAttempt: Number(environment.GITHUB_RUN_ATTEMPT), sourceCommit: environment.GITHUB_SHA };
  if (environment.GITHUB_REPOSITORY !== WINDOWS_NATIVE_REPOSITORY || environment.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || environment.GITHUB_REF !== "refs/heads/main" || environment.GITHUB_JOB !== "qualify"
    || !Number.isSafeInteger(producer.runId) || producer.runId <= 0 || !Number.isSafeInteger(producer.runAttempt) || producer.runAttempt <= 0
    || !/^[a-f0-9]{40}$/.test(producer.sourceCommit ?? "")) throw Error("Windows native producer requires the manual main qualification job");
  return producer;
}

export function windowsNativeArtifactName(identity, producer) {
  if (!/^[a-f0-9]{64}$/.test(identity)) throw Error("invalid Windows native input identity");
  return `windows-release-native-v1-${identity}-${producer.runId}-${producer.runAttempt}`;
}

export async function validateWindowsNativePayload(payload, { capture, verifyExecutable = verifyWindowsNativeExecutable, exactInventory = true } = {}) {
  if (exactInventory) assert.deepEqual((await readdir(payload)).sort(), WINDOWS_NATIVE_FILES, "unexpected Windows native payload inventory");
  const debugIds = {};
  for (const name of WINDOWS_NATIVE_FILES) {
    const file = await lstat(join(payload, name));
    if (!file.isFile() || file.isSymbolicLink() || file.size <= 0 || file.size > 512 * 1024 * 1024) throw Error(`nonregular/empty/oversized native file: ${name}`);
  }
  for (const name of binaries) {
    const binary = join(payload, name);
    await verifyExecutable(binary);
    debugIds[name] = await verifyWindowsRustDebugIdentity(binary, windowsRustPdbPath(binary), capture);
  }
  return debugIds;
}

export async function sealWindowsNative({ directory, outputDirectory, identity, producer, qualification, origin = null, ...verification }) {
  await rm(directory, { recursive: true, force: true });
  const payload = join(directory, "payload");
  await mkdir(payload, { recursive: true });
  for (const name of WINDOWS_NATIVE_FILES) await cp(join(outputDirectory, name), join(payload, name));
  const debugIds = await validateWindowsNativePayload(payload, verification);
  const manifest = { schema, identity, profile: WINDOWS_NATIVE_PROFILE, producer, origin, files: await inventory(payload), debugIds, qualification };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return { directory, payload, manifest };
}

export async function verifyWindowsNativeBundle({ directory, identity, producer, ...verification }) {
  const path = join(directory, "manifest.json");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw Error("invalid native manifest");
  assert.deepEqual((await readdir(directory)).sort(), ["manifest.json", "payload"], "unexpected native bundle entry");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  assert.equal(manifest.schema, schema);
  assert.equal(manifest.identity, identity);
  assert.deepEqual(manifest.profile, WINDOWS_NATIVE_PROFILE);
  assert.deepEqual(manifest.producer, producer);
  const payload = join(directory, "payload");
  if ((await lstat(payload)).isSymbolicLink()) throw Error("native payload cannot be a symlink");
  assert.deepEqual(await inventory(payload), manifest.files, "native payload hashes differ");
  assert.deepEqual(await validateWindowsNativePayload(payload, verification), manifest.debugIds);
  const proof = manifest.qualification;
  assert.equal(proof?.sourceCommit, producer.sourceCommit);
  assert.equal(proof?.scope, "windows-release-profile-packaged-lifecycle/v1");
  assert.deepEqual(proof?.profile, WINDOWS_NATIVE_PROFILE);
  for (const name of ["cleanProfileCreated", "lockContentionRejected", "cleanShutdown", "restartReopenedPersistedMarker"]) assert.equal(proof[name], true);
  for (const name of binaries) assert.equal(proof.binarySha256[name], manifest.files[name].sha256);
  return { directory, payload, manifest };
}

export async function installWindowsNative(bundle, destination, verification = {}) {
  await verifyWindowsNativeBundle({ directory: bundle.directory, identity: bundle.manifest.identity, producer: bundle.manifest.producer, ...verification });
  await mkdir(destination, { recursive: true });
  for (const name of WINDOWS_NATIVE_FILES) await cp(join(bundle.payload, name), join(destination, name));
  for (const name of WINDOWS_NATIVE_FILES) assert.equal(hash(await readFile(join(destination, name))), bundle.manifest.files[name].sha256, "installed native file differs");
  await validateWindowsNativePayload(destination, { ...verification, exactInventory: false });
}

export function validateWindowsNativeProducer({ artifact, run, jobs, identity, expected }) {
  const producer = { runId: run?.id, runAttempt: run?.run_attempt, sourceCommit: run?.head_sha };
  if (run?.repository?.full_name !== WINDOWS_NATIVE_REPOSITORY || run?.head_repository?.full_name !== WINDOWS_NATIVE_REPOSITORY
    || run?.path !== WINDOWS_NATIVE_WORKFLOW || run?.event !== "workflow_dispatch" || run?.head_branch !== "main"
    || !Number.isSafeInteger(producer.runId) || producer.runId <= 0 || !Number.isSafeInteger(producer.runAttempt) || producer.runAttempt <= 0
    || !/^[a-f0-9]{40}$/.test(producer.sourceCommit ?? "")
    || artifact?.name !== windowsNativeArtifactName(identity, producer) || artifact?.expired !== false
    || !Number.isSafeInteger(artifact?.id) || artifact.id <= 0 || !/^sha256:[a-f0-9]{64}$/.test(artifact?.digest ?? "")
    || artifact?.workflow_run?.id !== producer.runId || artifact?.workflow_run?.head_sha !== producer.sourceCommit || artifact?.workflow_run?.head_branch !== "main") throw Error("untrusted Windows native producer/artifact");
  if (expected) assert.deepEqual(producer, expected, "native handoff differs from current candidate run/attempt/source");
  for (const name of ["validate", "Qualify Windows native package"]) {
    const matches = (jobs?.jobs ?? []).filter(job => job.name === name && job.status === "completed" && job.conclusion === "success"
      && job.run_id === producer.runId && job.run_attempt === producer.runAttempt && job.head_sha === producer.sourceCommit);
    if (matches.length !== 1) throw Error(`native producer lacks successful ${name} job`);
    if (name === "Qualify Windows native package" && !matches[0].labels?.includes("windows-2025")) throw Error("native producer requires Windows 2025 runner");
    const required = name === "validate" ? ["Require protected main source", "Require exact-source main CI"] : ["Qualify release native inputs once", "Preserve qualified Windows native inputs"];
    for (const step of required) if (matches[0].steps?.find(entry => entry.name === step)?.conclusion !== "success") throw Error(`native producer lacks successful ${step}`);
  }
  return producer;
}

export async function extractWindowsNativeArchive(archive, directory, { timeout = 120_000 } = {}) {
  // Exact file allowlist makes traversal, backslashes, case aliases, directories,
  // symlinks, encryption, duplicate names and extra files invalid before writing.
  await execute(process.platform === "win32" ? "python" : "python3", ["-I", "-c", `
import pathlib,stat,sys,zipfile
root=pathlib.Path(sys.argv[2])
expected={'manifest.json','payload/relayer-app-server.exe','payload/relayer-graph-server.exe','payload/relayer_app_server.pdb','payload/relayer_graph_server.pdb'}
with zipfile.ZipFile(sys.argv[1]) as z:
 entries=z.infolist()
 names=[e.filename for e in entries]
 if len(names)!=len(set(n.casefold() for n in names)) or set(names)!=expected: raise ValueError('unexpected native archive inventory')
 if sum(e.file_size for e in entries)>2*1024**3: raise ValueError('native archive size limit')
 for e in entries:
  if stat.S_IFMT(e.external_attr>>16) not in (0,stat.S_IFREG) or e.flag_bits&1: raise ValueError('nonregular encrypted native entry')
  if e.file_size<=0 or e.file_size>(1048576 if e.filename=='manifest.json' else 512*1024**2): raise ValueError('native entry size limit')
  p=root/e.filename
  p.parent.mkdir(parents=True,exist_ok=True)
  with z.open(e) as source,p.open('xb') as output:
   while chunk:=source.read(1048576): output.write(chunk)
  p.chmod(0o644)
`, archive, directory], { timeout, maxBuffer: 1024 * 1024 });
}

async function downloadArchive({ fetchImpl, url, headers, destination, digest, timeout }) {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!response.ok || !response.body) throw Error(`native archive download HTTP ${response.status}`);
  const file = await open(destination, "wx");
  const digestHash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 ** 3) throw Error("native archive download size limit");
      digestHash.update(chunk); await file.writeFile(chunk);
    }
  } finally { await file.close(); }
  assert.equal(`sha256:${digestHash.digest("hex")}`, digest, "native archive digest mismatch");
}

export async function restoreWindowsNative({ identity, directory, environment = process.env, expected, fetchImpl = fetch, extract = extractWindowsNativeArchive, report = console.log, ...verification }) {
  const required = Boolean(expected);
  const deadline = Date.now() + (required ? 240_000 : 120_000);
  const remaining = maximum => {
    const value = Math.min(maximum, deadline - Date.now());
    if (value <= 0) throw Error("Windows native cache lookup time budget exhausted");
    return value;
  };
  try {
    if (!environment.GITHUB_TOKEN) throw Error("native artifact lookup token unavailable");
    const headers = { Accept: "application/vnd.github+json", Authorization: `Bearer ${environment.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2022-11-28" };
    const base = `https://api.github.com/repos/${WINDOWS_NATIVE_REPOSITORY}/actions`;
    const json = async url => {
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(remaining(15_000)) });
      if (!response.ok) throw Error(`native metadata HTTP ${response.status}`);
      return response.json();
    };
    const candidates = [];
    for (let page = 1; page <= (required ? 1 : 5) && candidates.length < 5; page++) {
      const listing = await json(required ? `${base}/runs/${expected.runId}/artifacts?per_page=100` : `${base}/artifacts?per_page=100&page=${page}`);
      candidates.push(...(listing.artifacts ?? []).filter(item => (required ? item.name === windowsNativeArtifactName(identity, expected) : item.name?.startsWith(`windows-release-native-v1-${identity}-`)) && !item.expired).slice(0, 5 - candidates.length));
      if ((listing.artifacts ?? []).length < 100 || page * 100 >= listing.total_count) break;
    }
    if (required && candidates.length !== 1) throw Error("current candidate requires one exact qualified native artifact");
    for (const candidate of candidates) {
      let staging;
      try {
        if (!Number.isSafeInteger(candidate.id) || candidate.id <= 0) throw Error("invalid native artifact ID");
        const artifact = await json(`${base}/artifacts/${candidate.id}`);
        if (!Number.isSafeInteger(artifact.workflow_run?.id)) throw Error("invalid native producer run");
        const run = await json(`${base}/runs/${artifact.workflow_run.id}`);
        if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt <= 0) throw Error("invalid producer attempt");
        const jobsUrl = `${base}/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`;
        const jobs = await json(jobsUrl);
        const producer = validateWindowsNativeProducer({ artifact, run, jobs, identity, expected });
        staging = await mkdtemp(join(tmpdir(), "relayer-windows-native-"));
        const archive = join(staging, "artifact.zip");
        const content = join(staging, "bundle"); await mkdir(content);
        await downloadArchive({ fetchImpl, url: `${base}/artifacts/${artifact.id}/zip`, headers, destination: archive, digest: artifact.digest, timeout: remaining(120_000) });
        await extract(archive, content, { timeout: remaining(120_000) });
        await verifyWindowsNativeBundle({ directory: content, identity, producer, ...verification });
        // Revalidate after download: a rerun may not reinterpret producer identity.
        validateWindowsNativeProducer({ artifact: await json(`${base}/artifacts/${artifact.id}`), run: await json(`${base}/runs/${run.id}`), jobs: await json(jobsUrl), identity, expected });
        await rm(directory, { recursive: true, force: true });
        await cp(content, directory, { recursive: true, errorOnExist: true });
        const bundle = await verifyWindowsNativeBundle({ directory, identity, producer, ...verification });
        report(`Windows native artifact verified: ${artifact.id}, ${artifact.digest}, producer ${producer.runId}/${producer.runAttempt}`);
        return { ...bundle, artifactId: artifact.id, artifactDigest: artifact.digest };
      } catch (error) {
        if (required) throw error;
        report(`Windows native cache rejected: ${error.message}`);
      } finally { if (staging) await rm(staging, { recursive: true, force: true }); }
    }
    if (required) throw Error("qualified native handoff missing");
    report("Windows native cache miss; compile once from locked native inputs");
  } catch (error) {
    if (required) throw error;
    report(`Windows native cache unavailable: ${error.message}; compile once`);
  }
  return null;
}
