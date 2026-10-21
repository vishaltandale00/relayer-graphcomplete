// Heavy, opt-in, inference-free native-service upgrade proof; not an installed-app canary.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { extractAll } from "@electron/asar";
import { directoryProvenance, executableProvenance, workspaceProvenance } from "./recursive-live-run-provenance.mjs";
import { digest, runOwned, verifyArchive, verifyMetadata } from "./upgrade-replay/contract.mjs";

const root = resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: {
  "baseline-archive": { type: "string" },
  "candidate-app": { type: "string" },
  "evidence-directory": { type: "string" },
} });
assert.equal(`${process.platform}-${process.arch}`, "darwin-arm64", "Upgrade replay requires macOS Apple Silicon");
const baseline = JSON.parse(await readFile(join(import.meta.dirname, "upgrade-replay/baseline.v1.json"), "utf8"));
const output = resolve(values["evidence-directory"] ?? join(root, ".relayer/evidence/upgrade-replay"));
await mkdir(output, { recursive: true });
await rm(join(output, "receipt.json"), { force: true });
const temporary = await mkdtemp(join(tmpdir(), "relayer-upgrade-replay-v1-"));
const receipt = {
  schemaVersion: 1, fixtureVersion: baseline.fixtureVersion,
  proof: "native-service-upgrade-replay", passed: false,
  source: workspaceProvenance(root), predecessor: baseline,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  runs: [],
  excluded: ["Electron main startup and renderer interaction", "installer/updater and signing", "vendor authentication", "managed runtime downloads and native probes", "live model authoring"],
};
// A stopped run or failed cleanup must never leave an earlier successful receipt.
await writeFile(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);

const run = (command, args, timeoutMs) => runOwned(command, args, { cwd: root, timeoutMs });

try {
  const archive = values["baseline-archive"] ? resolve(values["baseline-archive"]) : join(temporary, "baseline.zip");
  if (!values["baseline-archive"]) await run("curl", ["--fail", "--location", "--silent", "--show-error", "--max-time", "180", "--output", archive, baseline.url], 190_000);
  await verifyArchive(archive, baseline); // Verify bytes before extracting executable content.
  const installation = join(temporary, "predecessor");
  await mkdir(installation);
  await run("ditto", ["-x", "-k", archive, installation]);
  const apps = (await readdir(installation)).filter(name => name.endsWith(".app"));
  assert.equal(apps.length, 1);
  const resources = join(installation, apps[0], "Contents/Resources");
  const modules = join(temporary, "old-modules");
  extractAll(join(resources, "app.asar"), modules);
  verifyMetadata(JSON.parse(await readFile(join(modules, "package.json"), "utf8")), baseline);
  const candidateResources = values["candidate-app"] ? join(resolve(values["candidate-app"]), "Contents/Resources") : null;
  // CI consumes the native binaries just built and inspected by the packaging job.
  // Local default performs an ordinary incremental Cargo build for this checkout;
  // trusted warm Cargo inputs accelerate compilation without substituting provenance.
  if (!candidateResources) await run("cargo", ["build", "--locked", "-p", "relayer-app-server", "-p", "relayer-graph-server"], 300_000);
  const candidateBin = candidateResources ? join(candidateResources, "bin") : join(root, "target/debug");
  const candidateModules = candidateResources ? join(temporary, "candidate-modules") : join(root, "desktop");
  if (candidateResources) {
    extractAll(join(candidateResources, "app.asar"), candidateModules);
    const metadata = JSON.parse(await readFile(join(candidateModules, "package.json"), "utf8"));
    const desktop = JSON.parse(await readFile(join(root, "desktop/package.json"), "utf8"));
    verifyMetadata(metadata, { version: desktop.version, sourceCommit: receipt.source.commit, target: baseline.target });
    assert.equal(receipt.source.clean, true, "Packaged upgrade proof requires a clean source-bound checkout");
    receipt.candidatePackage = { sourceCommit: metadata.relayerReleaseSourceCommit, version: metadata.version, target: metadata.relayerReleaseTarget, asar: executableProvenance(join(candidateResources, "app.asar")) };
  }
  // Snapshot native executable bytes before any process starts; later phases use private
  // copies, so another checkout's build cannot replace executables mid-replay.
  const privateBin = join(temporary, "candidate-bin");
  await mkdir(privateBin);
  for (const name of ["relayer-app-server", "relayer-graph-server"]) await cp(join(candidateBin, name), join(privateBin, name));
  const generatedIdentity = () => ({
    modules: directoryProvenance(candidateResources ? candidateModules : join(root, "desktop/main")),
    packages: Object.fromEntries(["graph-client", "harness-host", "visual-assets"].map(name => [name, directoryProvenance(candidateResources ? join(candidateModules, "node_modules/@relayer", name) : join(root, "packages", name, "dist"))])),
  });
  receipt.candidate = {
    mode: candidateResources ? "same-job-packaged-application" : "checkout-incremental-cargo-build",
    binaries: Object.fromEntries(["relayer-app-server", "relayer-graph-server"].map(name => [name, executableProvenance(join(privateBin, name))])),
    ...generatedIdentity(),
  };
  receipt.predecessorBinaries = Object.fromEntries(["relayer-app-server", "relayer-graph-server"].map(name => [name, executableProvenance(join(resources, "bin", name))]));
  for (let replay = 1; replay <= 2; replay++) {
    const profile = join(temporary, `profile-${replay}`);
    await mkdir(profile);
    assert.deepEqual(await readdir(profile), [], "Each replay must begin with empty stores");
    const record = { replay, beganEmpty: true, phases: [] };
    receipt.runs.push(record);
    for (const phase of ["seed", "upgrade", "recover", "reopen"]) {
      const old = phase === "seed";
      const resultPath = join(output, `replay-${replay}-${phase}.json`);
      await rm(resultPath, { force: true });
      const optionsPath = join(temporary, `options-${replay}-${phase}.json`);
      await writeFile(optionsPath, JSON.stringify({
        phase, profile, resultPath, baselinePath: join(output, `replay-${replay}-seed.json`),
        modules: old ? modules : candidateModules,
        bin: old ? join(resources, "bin") : privateBin,
        harnesses: old ? join(resources, "harnesses") : candidateResources ? join(candidateResources, "harnesses") : join(root, "harnesses"),
        permissions: old ? join(resources, "permissions/desktop.json") : candidateResources ? join(candidateResources, "permissions/desktop.json") : join(root, "permissions/desktop.json"),
        renderer: old ? join(resources, "renderer") : candidateResources ? join(candidateResources, "renderer") : join(root, "desktop/renderer"),
      }));
      console.log(`Upgrade replay ${replay}/2: ${phase}`);
      await run(process.execPath, [join(import.meta.dirname, "upgrade-replay/worker.mjs"), optionsPath]);
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      assert.equal(result.passed, true, `Inner ${phase} phase did not pass`);
      assert.ok(result.checkpoints.length > 0);
      record.phases.push(result);
      if (old) record.baselineFingerprint = digest(result.saved);
    }
    await rm(profile, { recursive: true });
    record.profileDeleted = true;
  }
  assert.equal(receipt.runs[0].baselineFingerprint, receipt.runs[1].baselineFingerprint, "Independent baselines differ");
  assert.equal(new Set(receipt.runs.flatMap(run => run.phases.map(phase => phase.workerPid))).size, 8, "Each phase requires a new process");
  assert.deepEqual(workspaceProvenance(root), receipt.source, "Source changed during upgrade proof");
  assert.deepEqual(generatedIdentity(), { modules: receipt.candidate.modules, packages: receipt.candidate.packages }, "Executed modules or generated packages changed during upgrade proof");
  receipt.passed = true;
} catch (error) {
  // Failure message is retained, not raw local service logs or private profile stores.
  receipt.failure = error.message;
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
  receipt.temporaryStateDeleted = true;
  await writeFile(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}
console.log(`Upgrade replay passed twice. Evidence: ${join(output, "receipt.json")}`);
