import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  API_CONTRACT_SIMULATION_LABORATORY_CASE_ID,
  API_CONTRACT_SIMULATION_LABORATORY_VERIFIER_SOURCE_SHA256,
  apiContractSimulationLaboratoryCase,
  gradeApiContractSimulationLaboratoryWorkspace,
  materializeApiContractSimulationLaboratoryFixture,
  verifyApiContractSimulationLaboratoryPublicSeam,
  type LaboratoryLauncher,
} from "../src/project-cases/api-contract-simulation-laboratory.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);
const fixtureServer = fileURLToPath(new URL("./fixtures/api-contract-simulation-laboratory-server.mjs", import.meta.url));
const classFixtureServer = fileURLToPath(new URL("./fixtures/api-contract-simulation-laboratory-class-server.mjs", import.meta.url));

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function testLauncher(options: { architecture?: "interpreted" | "compiled"; mutant?: string; implementation?: "functional" | "class" } = {}): LaboratoryLauncher {
  return async () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.implementation === "class" ? classFixtureServer : fixtureServer, "--port", "0"], {
      env: {
        ...process.env,
        RELAYER_API_LAB_ARCHITECTURE: options.architecture ?? "interpreted",
        RELAYER_API_LAB_MUTANT: options.mutant ?? "none",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`test laboratory startup timeout: ${stderr}`)); }, 3_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`test laboratory exited ${code}: ${stderr}`)));
    createInterface({ input: child.stdout }).on("line", (line) => {
      let ready;
      try { ready = JSON.parse(line); } catch { return; }
      if (ready.type !== "ready") return;
      clearTimeout(timeout);
      resolve({
        baseUrl: ready.baseUrl,
        stop: () => new Promise<void>((done) => {
          if (child.exitCode !== null) { done(); return; }
          child.once("exit", () => done());
          child.kill("SIGTERM");
        }),
      });
    });
  });
}

async function verifyWith(options: { architecture?: "interpreted" | "compiled"; mutant?: string; implementation?: "functional" | "class" } = {}) {
  const laboratory = await testLauncher(options)("/unused");
  try { return await verifyApiContractSimulationLaboratoryPublicSeam(laboratory.baseUrl); }
  finally { await laboratory.stop(); }
}

describe("API Contract Simulation Laboratory capability case", () => {
  it("publishes one immutable candidate snapshot without leaking evaluator paths", () => {
    expect(apiContractSimulationLaboratoryCase.definition.id).toBe(API_CONTRACT_SIMULATION_LABORATORY_CASE_ID);
    expect(apiContractSimulationLaboratoryCase.snapshot.authoringStatus).toBe("candidate");
    expect(apiContractSimulationLaboratoryCase.snapshot.artifacts.verifier.mandatoryGates.map(({ id }) => id)).toEqual([
      "contract-import",
      "mock-routing",
      "request-response-validation",
      "fault-injection",
      "bounded-http",
      "revision-compatibility",
      "deterministic-replay",
      "scoped-api-laboratory-delivery",
    ]);
    expect(apiContractSimulationLaboratoryCase.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(apiContractSimulationLaboratoryCase.catalogSnapshot.artifacts.reference).not.toHaveProperty("sealedPath");
    expect(apiContractSimulationLaboratoryCase.catalogSnapshot.artifacts.verifier).not.toHaveProperty("sealedPath");
  });

  it("binds the normalized complete verifier source into its immutable identity", async () => {
    const sourcePath = fileURLToPath(new URL("../src/project-cases/api-contract-simulation-laboratory.ts", import.meta.url));
    const source = (await readFile(sourcePath, "utf8")).replace(
      /export const API_CONTRACT_SIMULATION_LABORATORY_VERIFIER_SOURCE_SHA256 = "[^"]+";/,
      'export const API_CONTRACT_SIMULATION_LABORATORY_VERIFIER_SOURCE_SHA256 = "<normalized>";',
    );
    expect(createHash("sha256").update(source).digest("hex")).toBe(API_CONTRACT_SIMULATION_LABORATORY_VERIFIER_SOURCE_SHA256);
  });

  it("materializes the frozen greenfield fixture reproducibly with a clean red baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-api-lab-red-"));
    temporaryDirectories.push(root);
    const workspaceDirectory = join(root, "workspace");
    const receipt = await materializeApiContractSimulationLaboratoryFixture({ workspaceDirectory, platform: "darwin" });
    const status = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: workspaceDirectory });
    expect(status.stdout).toBe("");
    expect(receipt.sourceRevision).toBe(apiContractSimulationLaboratoryCase.snapshot.artifacts.workspace.revision);
    expect(receipt.seededCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(await readFile(join(workspaceDirectory, "contracts/orders-v1.json"), "utf8")).toContain('"revision": "orders-v1"');

    const checks = await gradeApiContractSimulationLaboratoryWorkspace({ workspaceDirectory, baseRevision: receipt.seededCommit });
    const behavior = checks.filter(({ name }) => !["runtime-contract", "artifact-scope", "protected-contracts", "delivery-"].some((fragment) => name.includes(fragment)));
    expect(behavior).toHaveLength(13);
    expect(behavior.every(({ passed }) => !passed)).toBe(true);
    expect(checks.find(({ name }) => name === "workspace:delivery-commit")).toMatchObject({ passed: false });
  });

  it("accepts two independently structured green implementations through only the public HTTP seam", async () => {
    for (const candidate of [{ implementation: "functional" }, { implementation: "class" }] as const) {
      const checks = await verifyWith(candidate);
      expect(checks).toHaveLength(13);
      expect(checks.every(({ passed }) => passed), `${candidate.implementation}: ${JSON.stringify(checks)}`).toBe(true);
    }
  });

  it("qualifies two committed green projects after applying each diff to a pristine verifier workspace", async () => {
    for (const [implementation, sourcePath] of [["functional", fixtureServer], ["class", classFixtureServer]] as const) {
      const root = await mkdtemp(join(tmpdir(), `relayer-api-lab-green-${implementation}-`));
      temporaryDirectories.push(root);
      const workspaceDirectory = join(root, "workspace");
      const receipt = await materializeApiContractSimulationLaboratoryFixture({ workspaceDirectory, platform: "darwin" });
      await copyFile(sourcePath, join(workspaceDirectory, "server.mjs"));
      await execFileAsync("git", ["add", "server.mjs"], { cwd: workspaceDirectory });
      await execFileAsync("git", ["commit", "--quiet", "-m", `Implement ${implementation} API laboratory`], { cwd: workspaceDirectory });

      const checks = await gradeApiContractSimulationLaboratoryWorkspace({ workspaceDirectory, baseRevision: receipt.seededCommit });
      expect(checks.every(({ passed }) => passed), `${implementation}: ${JSON.stringify(checks)}`).toBe(true);
    }
  }, 15_000);

  it("rejects protected-contract substitution and uncommitted delivery independently", async () => {
    const protectedRoot = await mkdtemp(join(tmpdir(), "relayer-api-lab-protected-mutant-"));
    temporaryDirectories.push(protectedRoot);
    const protectedWorkspace = join(protectedRoot, "workspace");
    const protectedReceipt = await materializeApiContractSimulationLaboratoryFixture({ workspaceDirectory: protectedWorkspace, platform: "darwin" });
    await writeFile(join(protectedWorkspace, "contracts/orders-v1.json"), "{}\n", "utf8");
    await execFileAsync("git", ["add", "contracts/orders-v1.json"], { cwd: protectedWorkspace });
    await execFileAsync("git", ["commit", "--quiet", "-m", "Mutate protected contract"], { cwd: protectedWorkspace });
    const protectedChecks = await gradeApiContractSimulationLaboratoryWorkspace({ workspaceDirectory: protectedWorkspace, baseRevision: protectedReceipt.seededCommit, launch: testLauncher() });
    expect(protectedChecks.find(({ name }) => name === "workspace:protected-contracts")).toMatchObject({ passed: false });

    const deliveryRoot = await mkdtemp(join(tmpdir(), "relayer-api-lab-delivery-mutant-"));
    temporaryDirectories.push(deliveryRoot);
    const deliveryWorkspace = join(deliveryRoot, "workspace");
    const deliveryReceipt = await materializeApiContractSimulationLaboratoryFixture({ workspaceDirectory: deliveryWorkspace, platform: "darwin" });
    await copyFile(fixtureServer, join(deliveryWorkspace, "server.mjs"));
    const deliveryChecks = await gradeApiContractSimulationLaboratoryWorkspace({ workspaceDirectory: deliveryWorkspace, baseRevision: deliveryReceipt.seededCommit, launch: testLauncher() });
    expect(deliveryChecks.find(({ name }) => name === "workspace:delivery-commit")).toMatchObject({ passed: false });
    expect(deliveryChecks.find(({ name }) => name === "workspace:delivery-clean")).toMatchObject({ passed: false });
  }, 15_000);

  it("rejects dependency-bearing, generated, and ambient-runtime delivery shortcuts", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-api-lab-runtime-mutant-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const receipt = await materializeApiContractSimulationLaboratoryFixture({ workspaceDirectory: workspace, platform: "darwin" });
    const manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
    manifest.scripts.start = "python3 server.py";
    manifest.dependencies = { shortcut: "1.0.0" };
    await writeFile(join(workspace, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await mkdir(join(workspace, "vendor"));
    await writeFile(join(workspace, "vendor", "shortcut.js"), "export default true;\n", "utf8");
    await execFileAsync("git", ["add", "package.json", "vendor/shortcut.js"], { cwd: workspace });
    await execFileAsync("git", ["commit", "--quiet", "-m", "Use ambient runtime shortcut"], { cwd: workspace });
    const checks = await gradeApiContractSimulationLaboratoryWorkspace({ workspaceDirectory: workspace, baseRevision: receipt.seededCommit, launch: testLauncher() });
    expect(checks.find(({ name }) => name === "workspace:runtime-contract")).toMatchObject({ passed: false });
    expect(checks.find(({ name }) => name === "workspace:artifact-scope")).toMatchObject({ passed: false, detail: expect.stringContaining("vendor/shortcut.js") });
  }, 10_000);

  it("rejects absolute runtime entries and npm start lifecycle hooks", async () => {
    for (const [name, mutate] of [
      ["absolute", (manifest: any) => { manifest.scripts.start = "node /tmp/ambient.js"; }],
      ["prestart", (manifest: any) => { manifest.scripts.prestart = "node helper.mjs"; }],
      ["poststart", (manifest: any) => { manifest.scripts.poststart = "node helper.mjs"; }],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `relayer-api-lab-${name}-mutant-`));
      temporaryDirectories.push(root);
      const workspace = join(root, "workspace");
      const receipt = await materializeApiContractSimulationLaboratoryFixture({ workspaceDirectory: workspace, platform: "darwin" });
      const manifest = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
      mutate(manifest);
      await writeFile(join(workspace, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await execFileAsync("git", ["add", "package.json"], { cwd: workspace });
      await execFileAsync("git", ["commit", "--quiet", "-m", `Attempt ${name} runtime shortcut`], { cwd: workspace });
      const checks = await gradeApiContractSimulationLaboratoryWorkspace({ workspaceDirectory: workspace, baseRevision: receipt.seededCommit, launch: testLauncher() });
      expect(checks.find(({ name: checkName }) => checkName === "workspace:runtime-contract"), name).toMatchObject({ passed: false });
    }
  }, 15_000);

  it("denies ambient executable use even when the committed Node delivery shape is valid", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-api-lab-exec-mutant-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const receipt = await materializeApiContractSimulationLaboratoryFixture({ workspaceDirectory: workspace, platform: "darwin" });
    await writeFile(join(workspace, "server.mjs"), [
      'import { spawnSync } from "node:child_process";',
      "let available = false;",
      'try { available = spawnSync("/bin/sh", ["-c", "exit 0"]).status === 0; } catch {}',
      'console.error(available ? "ambient runtime unexpectedly available" : "ambient runtime denied");',
      "process.exit(1);",
      "",
    ].join("\n"), "utf8");
    await execFileAsync("git", ["add", "server.mjs"], { cwd: workspace });
    await execFileAsync("git", ["commit", "--quiet", "-m", "Attempt ambient executable shortcut"], { cwd: workspace });
    const checks = await gradeApiContractSimulationLaboratoryWorkspace({ workspaceDirectory: workspace, baseRevision: receipt.seededCommit });
    expect(checks.find(({ name }) => name === "workspace:runtime-contract")).toMatchObject({ passed: true });
    expect(checks.find(({ name }) => name === "workspace:artifact-scope")).toMatchObject({ passed: true });
    expect(checks.find(({ name }) => name === "workspace:contract-import")).toMatchObject({ passed: false, detail: expect.stringMatching(/ambient runtime denied/) });
  });

  it("denies packages bundled beside the pinned Node runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-api-lab-ambient-package-mutant-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const receipt = await materializeApiContractSimulationLaboratoryFixture({ workspaceDirectory: workspace, platform: "darwin" });
    await writeFile(join(workspace, "server.mjs"), [
      'import { createRequire } from "node:module";',
      'import { dirname, join } from "node:path";',
      'const require = createRequire(import.meta.url);',
      "try {",
      '  require(join(dirname(dirname(process.execPath)), "lib/node_modules/npm/node_modules/semver"));',
      '  console.error("ambient package unexpectedly available");',
      "} catch {",
      '  console.error("ambient package denied");',
      "}",
      "process.exit(1);",
      "",
    ].join("\n"), "utf8");
    await execFileAsync("git", ["add", "server.mjs"], { cwd: workspace });
    await execFileAsync("git", ["commit", "--quiet", "-m", "Attempt ambient package shortcut"], { cwd: workspace });
    const checks = await gradeApiContractSimulationLaboratoryWorkspace({ workspaceDirectory: workspace, baseRevision: receipt.seededCommit });
    expect(checks.find(({ name }) => name === "workspace:runtime-contract")).toMatchObject({ passed: true });
    expect(checks.find(({ name }) => name === "workspace:artifact-scope")).toMatchObject({ passed: true });
    expect(checks.find(({ name }) => name === "workspace:contract-import")).toMatchObject({ passed: false, detail: expect.stringMatching(/ambient package denied/) });
  });

  it("denies globally installed packages outside the pinned runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "relayer-api-lab-global-package-mutant-"));
    temporaryDirectories.push(root);
    const workspace = join(root, "workspace");
    const receipt = await materializeApiContractSimulationLaboratoryFixture({ workspaceDirectory: workspace, platform: "darwin" });
    await writeFile(join(workspace, "server.mjs"), [
      'import { createRequire } from "node:module";',
      'const require = createRequire(import.meta.url);',
      "try {",
      '  require("/opt/homebrew/lib/node_modules/npm/node_modules/semver");',
      '  console.error("global package unexpectedly available");',
      "} catch {",
      '  console.error("global package denied");',
      "}",
      "process.exit(1);",
      "",
    ].join("\n"), "utf8");
    await execFileAsync("git", ["add", "server.mjs"], { cwd: workspace });
    await execFileAsync("git", ["commit", "--quiet", "-m", "Attempt global package shortcut"], { cwd: workspace });
    const checks = await gradeApiContractSimulationLaboratoryWorkspace({ workspaceDirectory: workspace, baseRevision: receipt.seededCommit });
    expect(checks.find(({ name }) => name === "workspace:runtime-contract")).toMatchObject({ passed: true });
    expect(checks.find(({ name }) => name === "workspace:artifact-scope")).toMatchObject({ passed: true });
    expect(checks.find(({ name }) => name === "workspace:contract-import")).toMatchObject({ passed: false, detail: expect.stringMatching(/global package denied/) });
  });

  it("admits safe internal symlinks while rejecting broken and escaping links", async () => {
    const safeRoot = await mkdtemp(join(tmpdir(), "relayer-api-lab-safe-links-"));
    temporaryDirectories.push(safeRoot);
    const safeWorkspace = join(safeRoot, "workspace");
    const safeReceipt = await materializeApiContractSimulationLaboratoryFixture({ workspaceDirectory: safeWorkspace, platform: "darwin" });
    await symlink(".", join(safeWorkspace, "workspace-root"));
    await symlink("README.md", join(safeWorkspace, "readme-link"));
    await execFileAsync("git", ["add", "workspace-root", "readme-link"], { cwd: safeWorkspace });
    await execFileAsync("git", ["commit", "--quiet", "-m", "Add safe internal links"], { cwd: safeWorkspace });
    const safeChecks = await gradeApiContractSimulationLaboratoryWorkspace({ workspaceDirectory: safeWorkspace, baseRevision: safeReceipt.seededCommit, launch: testLauncher() });
    expect(safeChecks.every(({ passed }) => passed), JSON.stringify(safeChecks)).toBe(true);

    const unsafeRoot = await mkdtemp(join(tmpdir(), "relayer-api-lab-unsafe-links-"));
    temporaryDirectories.push(unsafeRoot);
    const unsafeWorkspace = join(unsafeRoot, "workspace");
    const unsafeReceipt = await materializeApiContractSimulationLaboratoryFixture({ workspaceDirectory: unsafeWorkspace, platform: "darwin" });
    await symlink("missing-target", join(unsafeWorkspace, "broken-link"));
    await symlink("/tmp", join(unsafeWorkspace, "escaping-link"));
    await execFileAsync("git", ["add", "broken-link", "escaping-link"], { cwd: unsafeWorkspace });
    await execFileAsync("git", ["commit", "--quiet", "-m", "Add unsafe links"], { cwd: unsafeWorkspace });
    const unsafeChecks = await gradeApiContractSimulationLaboratoryWorkspace({ workspaceDirectory: unsafeWorkspace, baseRevision: unsafeReceipt.seededCommit, launch: testLauncher() });
    expect(unsafeChecks.find(({ name }) => name === "workspace:contract-import")).toMatchObject({ passed: false, detail: expect.stringMatching(/escaping or broken symbolic link/) });
  });

  it("rejects adversarial shortcuts at their independent public predicates", async () => {
    const mutants = new Map([
      ["no-request-validation", "workspace:request-validation"],
      ["no-response-validation", "workspace:response-validation"],
      ["no-latency", "workspace:latency-injection"],
      ["no-failures", "workspace:failure-injection"],
      ["shallow-compatibility", "workspace:revision-comparison"],
      ["nondeterministic-replay", "workspace:deterministic-replay"],
      ["frozen-contracts-only", "workspace:contract-import"],
      ["inactive-selection", "workspace:property-contract"],
      ["fabricated-trace", "workspace:causal-trace"],
      ["fixed-causal-probes-only", "workspace:causal-trace"],
      ["wrong-failure-body", "workspace:failure-injection"],
      ["wrong-redirect", "workspace:bounded-redirect"],
      ["buffered-stream", "workspace:bounded-streaming"],
      ["wrong-response-example", "workspace:mock-routing"],
      ["no-scenario-validation", "workspace:failure-injection"],
      ["selective-operation-header", "workspace:bounded-redirect"],
      ["selective-success-header", "workspace:mock-routing"],
    ]);
    for (const [mutant, rejectedBy] of mutants) {
      const checks = await verifyWith({ mutant });
      expect(checks).toHaveLength(13);
      expect(checks.find(({ name }) => name === rejectedBy), mutant).toMatchObject({ passed: false });
      expect(new Set(checks.map(({ name }) => name)).size, `${mutant} hid independent evidence`).toBe(13);
    }
  }, 30_000);
});
