import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPackage } from "@electron/asar";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadDesktopReleaseContract, resolveDesktopReleaseContract } from "../desktop/release/contract.mjs";
import { buildDesktopRelease, buildReleaseNativeInputs, parseDesktopReleaseArguments, prepareWindowsNativeInputs } from "../desktop/release/build-release.mjs";
import { desktopReleaseTag, loadDesktopVersion } from "../desktop/release/version.mjs";
import { createDesktopBuilderConfig } from "../desktop/packaging/electron-builder.mjs";
import { verifyPackagedDesktopContract } from "../desktop/release/verify-packaged-contract.mjs";
import { validatePreviewPublicationProvenance } from "../desktop/release/publish-preview.mjs";
import { validateDesktopPreviewCandidateRun, WINDOWS_CANDIDATE_WORKFLOW_PATH } from "../desktop/release/preview-candidate-run.mjs";

const execFileAsync = promisify(execFile);

async function nativeHandoffFixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "windows-native-handoff-"));
  const environment = {
    GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "package",
    RELAYER_DESKTOP_RELEASE: "1", RELAYER_DESKTOP_TARGET: "windows-x64", RELAYER_DESKTOP_CHANNEL: "preview",
    RELAYER_DESKTOP_CANDIDATE_RUN_ID: "123", RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: "1",
    RELAYER_DESKTOP_UPDATE_BASE_URL: "https://updates.relayerlabs.ai/desktop/windows/x64",
    RELAYER_WINDOWS_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
    RELAYER_WINDOWS_SIGNING_ACCOUNT: "relayercodesigning", RELAYER_WINDOWS_CERTIFICATE_PROFILE: "relayer-windows",
    RELAYER_WINDOWS_PUBLISHER_NAME: "CN=Relayer Labs LLC, O=Relayer Labs LLC, L=Lewes, S=Delaware, C=US",
  };
  const contract = resolveDesktopReleaseContract({ environment, version: "0.2.0", sourceCommit: "a".repeat(40) });
  const directory = join(repositoryRoot, "target", contract.rustTarget, "release");
  const names = ["relayer-app-server.exe", "relayer_app_server.pdb", "relayer-graph-server.exe", "relayer_graph_server.pdb"];
  await mkdir(directory, { recursive: true });
  const receiptPath = join(repositoryRoot, "native.json");
  const produce = async () => { for (const name of names) await writeFile(join(directory, name), `native fixture: ${name}`); };
  return { repositoryRoot, environment, contract, directory, names, receiptPath, produce };
}

describe("independent Windows candidate", () => {
  it("dispatches CLI preparation and consumption through production release orchestration before assembly", async () => {
    const f = await nativeHandoffFixture();
    const commands = [];
    const options = { ...f, loadContract: async () => f.contract,
      execute: async (_command, args) => { commands.push(args); throw Error("assembly boundary reached"); } };
    try {
      await buildDesktopRelease({ ...options, ...parseDesktopReleaseArguments(["preview", "--prepare-windows-native", f.receiptPath]),
        buildNative: f.produce });
      expect(commands).toEqual([]);
      const consume = { ...options, ...parseDesktopReleaseArguments(["preview", "--use-windows-native", f.receiptPath]),
        buildNative: async () => { throw Error("unexpected compilation"); } };
      await writeFile(join(f.directory, f.names[0]), "tampered");
      await expect(buildDesktopRelease(consume)).rejects.toThrow("EXE/PDB bytes");
      expect(commands).toEqual([]);
      await f.produce();
      await expect(buildDesktopRelease(consume)).rejects.toThrow("assembly boundary reached");
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain("--win");
      expect(commands[0]).toContain("nsis");
      for (const args of [["preview", "--use-windows-native"], ["preview", "--skip-native", f.receiptPath],
        ["preview", "--prepare-windows-native", f.receiptPath, "extra"]]) {
        expect(() => parseDesktopReleaseArguments(args)).toThrow("Usage");
      }
    } finally { await rm(f.repositoryRoot, { recursive: true, force: true }); }
  });
  it("seals native inputs only after the production pinned release builder succeeds", async () => {
    const f = await nativeHandoffFixture();
    const commands = [];
    try {
      const result = await prepareWindowsNativeInputs({ ...f,
        prepareLadybug: async () => ({ environment: { OPENSSL_DIR: f.repositoryRoot, LBUG_SOURCE_DIR: f.repositoryRoot,
          OPENSSL_STATIC: "1", LBUG_BUILD_FROM_SOURCE: "1", CARGO_NET_OFFLINE: "true" }, dispose: async () => {} }),
        execute: async (command, args, options) => {
          commands.push({ command, args, environment: options.env });
          if (args[0] === "build") await f.produce();
        },
      });
      expect(result.nativeReceipt).toBe(f.receiptPath);
      expect(commands.map(call => call.args[0])).toEqual(["fetch", "build"]);
      expect(commands[1].args).toContain("--offline");
      expect(commands[1].environment.CARGO_PROFILE_RELEASE_DEBUG).toBe("1");
      expect(JSON.parse(await readFile(f.receiptPath, "utf8")).files).toHaveLength(4);
      await expect(prepareWindowsNativeInputs({ ...f,
        verifyLadybugDistributionLicense: async () => { throw Error("license blocked"); },
      })).rejects.toThrow("license blocked");
      await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(prepareWindowsNativeInputs({ ...f, buildNative: async () => { throw Error("native compilation failed"); } }))
        .rejects.toThrow("native compilation failed");
      await expect(readFile(f.receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(f.repositoryRoot, { recursive: true, force: true }); }
  });

  it("consumes only unchanged same-job EXE/PDB inputs without preparing or compiling native code", async () => {
    const f = await nativeHandoffFixture();
    try {
      await prepareWindowsNativeInputs({ ...f, buildNative: f.produce });
      const consume = { ...f, preparedWindowsNativeReceipt: f.receiptPath,
        buildNative: async () => { throw Error("native compilation must not run"); } };
      expect(await buildReleaseNativeInputs(consume)).toBeNull();
      for (const changed of [{ sourceCommit: "b".repeat(40) }, { version: "0.2.1" }, { channelName: "stable" },
        { targetKey: "macos-arm64" }, { candidateWorkflowRunId: "124" }, { candidateWorkflowRunAttempt: "2" },
        { publisherName: "CN=Other, O=Other" }]) {
        await expect(buildReleaseNativeInputs({ ...consume, contract: { ...f.contract, ...changed } })).rejects.toThrow("handoff");
      }
      for (const changed of [{ GITHUB_JOB: "different-job" }, { GITHUB_RUN_ID: "124" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_ACTIONS: "false" }]) {
        await expect(buildReleaseNativeInputs({ ...consume, environment: { ...f.environment, ...changed } })).rejects.toThrow("handoff");
      }
      await expect(buildReleaseNativeInputs({ ...consume, requireLicense: async () => { throw Error("license revoked"); } }))
        .rejects.toThrow("license revoked");
      for (const name of f.names) {
        await writeFile(join(f.directory, name), "changed native bytes");
        await expect(buildReleaseNativeInputs(consume)).rejects.toThrow("EXE/PDB bytes");
        await f.produce();
      }
      await rm(join(f.directory, f.names[0]));
      await symlink(join(f.directory, f.names[2]), join(f.directory, f.names[0]));
      await expect(buildReleaseNativeInputs(consume)).rejects.toThrow("regular file");
      expect(await buildReleaseNativeInputs({ contract: { targetKey: "macos-arm64" }, buildNative: async () => "ordinary native build" }))
        .toBe("ordinary native build");
    } finally { await rm(f.repositoryRoot, { recursive: true, force: true }); }
  });
  it("emits static OpenSSL system dependencies from the actual target build script", async () => {
    const root = await mkdtemp(join(tmpdir(), "windows-openssl-link-"));
    try {
      const executable = join(root, process.platform === "win32" ? "build-script.exe" : "build-script");
      await execFileAsync("rustc", [fileURLToPath(new URL("../crates/relayer-graph-server/build.rs", import.meta.url)), "-o", executable]);
      const directives = async (targetEnvironment, ladybug = true) => {
        const environment = { ...process.env, OPENSSL_DIR: root, CARGO_CFG_TARGET_ENV: targetEnvironment };
        delete environment.OPENSSL_LIB_DIR;
        delete environment.CARGO_FEATURE_LADYBUG;
        if (ladybug) environment.CARGO_FEATURE_LADYBUG = "1";
        const { stdout } = await execFileAsync(executable, [], { env: environment });
        return stdout.trim().split(/\r?\n/u).filter(line => line.startsWith("cargo:rustc-link-lib="));
      };
      expect(await directives("msvc")).toEqual([
        "cargo:rustc-link-lib=static=libssl", "cargo:rustc-link-lib=static=libcrypto",
        ...["gdi32", "user32", "crypt32", "ws2_32", "advapi32"].map(library => `cargo:rustc-link-lib=dylib=${library}`),
      ]);
      expect(await directives("")).toEqual(["cargo:rustc-link-lib=static=ssl", "cargo:rustc-link-lib=static=crypto"]);
      expect(await directives("msvc", false)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("checks out canonical generated query contracts with Windows line ending conversion enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "windows-contract-checkout-"));
    const generated = "packages/graph-client/src/query-errors.generated.ts";
    const python = "python/relayer-graph/src/relayer_graph/query_errors_generated.py";
    const generator = "packages/graph-client/scripts/generate-query-errors.mjs";
    try {
      for (const file of [".gitattributes", generated, python, generator, "docs/graph-query-v1-errors.json", "crates/relayer-graph-core/src/query/error.rs"]) {
        await mkdir(dirname(join(root, file)), { recursive: true });
        await writeFile(join(root, file), await readFile(new URL(`../${file}`, import.meta.url)));
      }
      const git = (...args) => execFileAsync("git", args, { cwd: root });
      await git("init", "--quiet");
      await git("config", "core.autocrlf", "true");
      await git("add", ".");
      await git("-c", "user.name=Qualification fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "canonical source");
      await rm(join(root, generated));
      await rm(join(root, python));
      await git("checkout", "--", generated, python);
      await execFileAsync(process.execPath, [join(root, generator), "--check"], { cwd: root });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("seals the Windows version in the real ASAR while retaining the macOS version", async () => {
    const root = await mkdtemp(join(tmpdir(), "windows-version-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.9.7" }));
      await writeFile(join(root, "windows-version.json"), JSON.stringify({ version: "0.2.0" }));
      expect(await loadDesktopVersion({ desktopRoot: root, targetKey: "macos-arm64" })).toBe("0.9.7");
      const contract = await loadDesktopReleaseContract({
        desktopRoot: root,
        environment: {
          RELAYER_DESKTOP_RELEASE: "1", RELAYER_DESKTOP_TARGET: "windows-x64", RELAYER_DESKTOP_CHANNEL: "preview",
          RELAYER_DESKTOP_CANDIDATE_RUN_ID: "123", RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: "1",
          RELAYER_DESKTOP_UPDATE_BASE_URL: "https://updates.relayerlabs.ai/desktop/windows/x64",
          RELAYER_WINDOWS_SIGNING_ENDPOINT: "https://eus.codesigning.azure.net/",
          RELAYER_WINDOWS_SIGNING_ACCOUNT: "relayercodesigning", RELAYER_WINDOWS_CERTIFICATE_PROFILE: "relayer-windows",
          RELAYER_WINDOWS_PUBLISHER_NAME: "CN=Relayer Labs LLC, O=Relayer Labs LLC, L=Lewes, S=Delaware, C=US",
        },
        execute: async (_command, args) => ({ stdout: args[0] === "rev-parse" ? "a".repeat(40) : "" }),
      });
      const builder = createDesktopBuilderConfig(contract, { environment: {}, argv: [] });
      const source = join(root, "asar-source");
      const appPath = join(root, "win-unpacked");
      const resources = join(appPath, "resources");
      await mkdir(join(source, "node_modules/electron-updater"), { recursive: true });
      await mkdir(resources, { recursive: true });
      await writeFile(join(source, "package.json"), JSON.stringify({ version: "0.9.7", ...builder.extraMetadata }));
      await writeFile(join(source, "node_modules/electron-updater/package.json"), "{}");
      await createPackage(source, join(resources, "app.asar"));
      await writeFile(join(resources, "app-update.yml"), `provider: generic\nurl: ${contract.updateBaseUrl}\nchannel: beta\n`);
      expect((await verifyPackagedDesktopContract({ appPath, contract })).packageMetadata.version).toBe("0.2.0");
      await expect(verifyPackagedDesktopContract({ appPath, contract: { ...contract, version: "0.9.7" } })).rejects.toThrow("metadata version");
      expect(desktopReleaseTag(contract.version, "windows-x64")).toBe("desktop-windows-v0.2.0");
      expect(desktopReleaseTag("0.9.7", "macos-arm64")).toBe("desktop-v0.9.7");
      await writeFile(join(root, "windows-version.json"), '{"version":"latest"}');
      await expect(loadDesktopVersion({ desktopRoot: root, targetKey: "windows-x64" })).rejects.toThrow("numeric");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("binds Windows publication provenance to its own tags and candidate workflow", () => {
    const digest = `sha256:${"b".repeat(64)}`;
    const environment = {
      GITHUB_SHA: "a".repeat(40), GITHUB_REF_NAME: "desktop-windows-v0.2.0", GITHUB_RUN_ID: "10", GITHUB_RUN_ATTEMPT: "1",
      RELAYER_DESKTOP_CANDIDATE_RUN_ID: "11", RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: "1",
      RELAYER_DESKTOP_CANDIDATE_ARTIFACT_ID: "12", RELAYER_DESKTOP_CANDIDATE_ARTIFACT_DIGEST: digest,
    };
    expect(validatePreviewPublicationProvenance(environment, "0.2.0", "windows-x64").candidateArtifactId).toBe("12");
    expect(() => validatePreviewPublicationProvenance({ ...environment, GITHUB_REF_NAME: "desktop-v0.2.0" }, "0.2.0", "windows-x64")).toThrow("desktop-windows-v");
    const input = {
      targets: ["windows-x64"], sourceCommit: environment.GITHUB_SHA, repository: "owner/repo", candidateRunId: "11", candidateRunAttempt: "1",
      candidateArtifacts: { "windows-x64": { id: "12", digest } },
      run: { id: 11, run_attempt: 1, event: "workflow_dispatch", status: "completed", head_sha: environment.GITHUB_SHA, head_branch: "main", path: WINDOWS_CANDIDATE_WORKFLOW_PATH, repository: { full_name: "owner/repo" } },
      jobs: { jobs: [{ name: "Sign Windows x64 Preview", status: "completed", conclusion: "success", run_attempt: 1 }] },
      artifacts: { artifacts: [{ id: 12, digest, expired: false, name: `relayer-desktop-preview-windows-x64-${environment.GITHUB_SHA}` }] },
    };
    expect(validateDesktopPreviewCandidateRun(input).candidateArtifacts["windows-x64"].id).toBe("12");
    expect(() => validateDesktopPreviewCandidateRun({ ...input, run: { ...input.run, path: ".github/workflows/desktop-signed-preview.yml" } })).toThrow("exact main commit");
  });

  it("lets the explicit label qualify any PR while isolating signing and main/mac dependencies", async () => {
    const workflow = parse(await readFile(new URL("../.github/workflows/desktop-windows-candidate.yml", import.meta.url), "utf8"));
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    expect(workflow.on.pull_request).toEqual({ types: ["opened", "synchronize", "reopened", "labeled"] });
    expect(workflow.jobs.qualify.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.qualify.if).toContain("contains(github.event.pull_request.labels.*.name, 'windows-qualification')");
    expect(workflow.jobs.qualify.if).toContain("needs.validate.result == 'success'");
    expect(workflow.jobs.qualify.environment).toBeUndefined();
    expect(workflow.jobs.package.if).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    expect(workflow.jobs.package.needs).toEqual(["validate", "qualify"]);
    expect(workflow.jobs.package.environment).toBe("desktop-production-windows");
    const steps = workflow.jobs.package.steps;
    for (const job of [workflow.jobs.qualify, workflow.jobs.package]) {
      const probe = job.steps.findIndex(step => step.run === "node scripts/check-windows-rust-symbols.mjs");
      const msvc = job.steps.findIndex(step => step.uses?.startsWith("ilammy/msvc-dev-cmd@"));
      const coldBuild = job.steps.findIndex(step => step.run?.includes("cargo fetch") || step.run?.includes("--prepare-windows-native"));
      expect(probe).toBeGreaterThan(msvc);
      expect(msvc).toBeGreaterThan(-1);
      expect(coldBuild).toBeGreaterThan(probe);
    }
    const preparation = steps.findIndex(step => step.run?.includes("--prepare-windows-native"));
    const login = steps.findIndex(step => step.uses?.startsWith("azure/login@"));
    const resourceToken = steps.findIndex(step => step.run?.includes("get-access-token"));
    const packaging = steps.findIndex(step => step.run?.includes("--use-windows-native"));
    expect(preparation).toBeGreaterThan(-1);
    expect(login).toBeGreaterThan(preparation);
    expect(resourceToken).toBeGreaterThan(login);
    expect(packaging).toBeGreaterThan(resourceToken);
    expect(steps[resourceToken].run).toBe("az account get-access-token --resource https://codesigning.azure.net --output none");
    expect(workflow.jobs.validate.steps.some(step => step.run === 'test "$GITHUB_REF" = refs/heads/main')).toBe(true);
    expect(workflow.jobs.validate.steps.some(step => step.run === "node desktop/release/main-ci-check.mjs")).toBe(true);
    const text = JSON.stringify(workflow);
    expect(text).not.toMatch(/configure-aws|publish-preview|promote-stable|desktop-update-preview/);
    for (const file of ["ci.yml", "desktop-signed-preview.yml"]) {
      const other = parse(await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
      expect(JSON.stringify(other.jobs)).not.toContain("desktop-windows-candidate");
      expect(other.jobs.check?.needs ?? []).not.toContain("ladybug-windows-qualification");
    }
  });
});
