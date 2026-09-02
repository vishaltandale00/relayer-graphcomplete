import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPackage } from "@electron/asar";
import { describe, expect, it, vi } from "vitest";

import {
  assertCredentialAbsentFromTree,
  createDesktopTelemetryUploadPlan,
  prepareDesktopTelemetryArtifacts,
  verifyDesktopTelemetryArtifacts,
} from "../desktop/release/telemetry-artifacts.mjs";

const commit = "0123456789abcdef0123456789abcdef01234567";

function contract(overrides = {}) {
  return {
    release: true,
    version: "0.2.17",
    sourceCommit: commit,
    targetKey: "macos-arm64",
    distributionPlatform: "macos",
    platform: "darwin",
    architecture: "arm64",
    rustTarget: "aarch64-apple-darwin",
    channelName: "preview",
    ...overrides,
  };
}

describe("desktop telemetry release artifacts", () => {
  it("produces, verifies, audits, and plans upload of sealed telemetry artifacts", async () => {
    // macOS: deterministic version-matched source maps and Rust debug artifacts.
    const root = await mkdtemp(join(tmpdir(), "relayer-telemetry-artifacts-"));
    const outputRoot = join(root, "desktop", "dist", "telemetry");
    const packagedApplication = join(root, "desktop", "dist", "mac-arm64", "Relayer.app");
    const packagedResources = join(packagedApplication, "Contents", "Resources");
    const asarSource = join(root, "asar-source");
    const sources = [
      ["electron", "desktop/main/index.mjs"],
      ["renderer", "desktop/renderer/src/main.js"],
      ["node", "packages/harness-host/dist/index.js"],
    ];
    for (const [, relativePath] of sources) {
      await mkdir(join(root, relativePath, ".."), { recursive: true });
      await writeFile(join(root, relativePath), "export const answer = 42;\n", "utf8");
    }
    await mkdir(join(asarSource, "main"), { recursive: true });
    await mkdir(join(asarSource, "node_modules", "@relayer", "harness-host", "dist"), { recursive: true });
    await mkdir(join(packagedResources, "renderer", "src"), { recursive: true });
    await writeFile(join(asarSource, "main", "index.mjs"), "export const answer = 42;\n", "utf8");
    await writeFile(join(asarSource, "node_modules", "@relayer", "harness-host", "dist", "index.js"), "export const answer = 42;\n", "utf8");
    await writeFile(join(packagedResources, "renderer", "src", "main.js"), "export const answer = 42;\n", "utf8");
    await createPackage(asarSource, join(packagedResources, "app.asar"));
    const rustBinary = join(root, "target", "aarch64-apple-darwin", "release", "relayer-app-server");
    const packagedRustBinary = join(packagedResources, "bin", "relayer-app-server");
    await mkdir(join(rustBinary, ".."), { recursive: true });
    await mkdir(join(packagedRustBinary, ".."), { recursive: true });
    await writeFile(rustBinary, "mach-o", "utf8");
    await writeFile(packagedRustBinary, "mach-o", "utf8");
    const execute = vi.fn(async (_command, args) => {
      const destination = args.at(-1);
      await mkdir(join(destination, "Contents", "Resources", "DWARF"), { recursive: true });
      await writeFile(join(destination, "Contents", "Resources", "DWARF", "relayer-app-server"), "debug", "utf8");
    });
    const capture = vi.fn(async () => ({ stdout: "UUID: 12345678-1234-1234-1234-123456789ABC (arm64) artifact\n" }));

    const first = await prepareDesktopTelemetryArtifacts({
      contract: contract(),
      repositoryRoot: root,
      outputRoot,
      packagedApplication,
      sourceGroups: sources,
      rustBinaries: [rustBinary],
      execute,
      capture,
    });
    const verified = await verifyDesktopTelemetryArtifacts({ outputRoot });
    expect(verified, "verification reproduces the manifest").toEqual(first);
    expect(first, "sealed manifest identity").toMatchObject({
      schema: "relayer.desktop-telemetry-artifacts/v1",
      release: `ai.relayer.desktop@0.2.17+${commit}`,
      candidateChannel: "preview",
      target: "macos-arm64",
      packagedApplication: "mac-arm64/Relayer.app",
    });
    expect(first.sourceMaps.map((entry) => entry.component), "source maps for every component").toEqual(["electron", "renderer", "node"]);
    expect(first.debugArtifacts.some((entry) => entry.path.endsWith("relayer-app-server")), "Rust debug artifact captured").toBe(true);
    expect(first.nativeDebugIdentities, "dSYM correlated by UUID").toEqual([{
      binary: "bin/relayer-app-server",
      debug: "debug/relayer-app-server.dSYM",
      debugId: "12345678-1234-1234-1234-123456789abc",
    }]);
    const map = JSON.parse(await readFile(join(outputRoot, "source-maps", "desktop/main/index.mjs.map"), "utf8"));
    expect(map, "source map pinned to its module").toMatchObject({ version: 3, file: "desktop/main/index.mjs", sources: ["desktop/main/index.mjs"] });

    const second = await prepareDesktopTelemetryArtifacts({
      contract: contract(),
      repositoryRoot: root,
      outputRoot,
      packagedApplication,
      sourceGroups: sources,
      rustBinaries: [rustBinary],
      execute,
      capture,
    });
    expect(second, "artifact preparation is deterministic").toEqual(first);
    await writeFile(join(outputRoot, first.sourceMaps[0].path), "tampered", "utf8");
    await expect(verifyDesktopTelemetryArtifacts({ outputRoot }), "tampered artifact fails verification")
      .rejects.toThrow("does not match its manifest");

    await writeFile(join(root, "desktop/main/index.mjs"), "export const mismatch = true;\n", "utf8");
    await expect(prepareDesktopTelemetryArtifacts({
      contract: contract(),
      repositoryRoot: root,
      outputRoot: join(root, "desktop", "dist", "mismatched-telemetry"),
      packagedApplication,
      sourceGroups: sources,
      rustBinaries: [rustBinary],
      execute,
      capture,
    }), "packaged bytes must match source bytes").rejects.toThrow("packaged source bytes");

    await writeFile(join(root, "desktop/main/index.mjs"), "export const answer = 42;\n", "utf8");
    const mismatchedUuidCapture = vi.fn(async (_command, args) => ({
      stdout: args[1].includes("mismatched-native")
        ? "UUID: AAAAAAAA-1234-1234-1234-123456789ABC (arm64) debug\n"
        : "UUID: 12345678-1234-1234-1234-123456789ABC (arm64) executable\n",
    }));
    await expect(prepareDesktopTelemetryArtifacts({
      contract: contract(),
      repositoryRoot: root,
      outputRoot: join(root, "desktop", "dist", "mismatched-native"),
      packagedApplication,
      sourceGroups: sources,
      rustBinaries: [rustBinary],
      execute,
      capture: mismatchedUuidCapture,
    }), "mismatched dSYM UUID rejected").rejects.toThrow("dSYM UUID");

    // Windows: the packaged PE CodeView identity correlates with its PDB.
    const winRoot = await mkdtemp(join(tmpdir(), "relayer-telemetry-windows-symbols-"));
    const winOutputRoot = join(winRoot, "desktop", "dist", "telemetry");
    const winPackagedApplication = join(winRoot, "desktop", "dist", "win-unpacked");
    const resources = join(winPackagedApplication, "resources");
    const winAsarSource = join(winRoot, "asar-source");
    await mkdir(join(winRoot, "desktop", "main"), { recursive: true });
    await mkdir(join(winAsarSource, "main"), { recursive: true });
    await writeFile(join(winRoot, "desktop", "main", "index.mjs"), "export const answer = 42;\n", "utf8");
    await writeFile(join(winAsarSource, "main", "index.mjs"), "export const answer = 42;\n", "utf8");
    await mkdir(resources, { recursive: true });
    await createPackage(winAsarSource, join(resources, "app.asar"));
    const winRustBinary = join(winRoot, "target", "x86_64-pc-windows-msvc", "release", "relayer-app-server.exe");
    await mkdir(join(winRustBinary, ".."), { recursive: true });
    await mkdir(join(resources, "bin"), { recursive: true });
    await writeFile(winRustBinary, "pe", "utf8");
    await writeFile(join(winRustBinary, "..", "relayer-app-server.pdb"), "pdb", "utf8");
    await writeFile(join(resources, "bin", "relayer-app-server.exe"), "pe", "utf8");
    const guid = "87654321-4321-4321-4321-cba987654321";
    const winCapture = vi.fn(async (command) => ({
      stdout: command === "llvm-readobj" ? `PDBGUID: {${guid}}\nPDBAge: 3\n` : `Guid: ${guid}\nAge: 3\n`,
    }));
    const windowsContract = contract({
      targetKey: "windows-x64",
      distributionPlatform: "windows",
      platform: "win32",
      architecture: "x64",
      rustTarget: "x86_64-pc-windows-msvc",
    });
    const winManifest = await prepareDesktopTelemetryArtifacts({
      contract: windowsContract,
      repositoryRoot: winRoot,
      outputRoot: winOutputRoot,
      packagedApplication: winPackagedApplication,
      sourceGroups: [["electron", "desktop/main/index.mjs"]],
      rustBinaries: [winRustBinary],
      capture: winCapture,
    });
    expect(winManifest.nativeDebugIdentities[0].debugId, "PE CodeView identity correlated with PDB").toBe(`${guid}-3`);
    expect(winCapture, "CodeView read from the packaged executable").toHaveBeenCalledWith("llvm-readobj", expect.arrayContaining([expect.stringMatching(/relayer-app-server\.exe$/u)]));

    const mismatchedCapture = vi.fn(async (command) => ({
      stdout: command === "llvm-readobj" ? `PDBGUID: {${guid}}\nPDBAge: 3\n` : `Guid: ${guid}\nAge: 4\n`,
    }));
    await expect(prepareDesktopTelemetryArtifacts({
      contract: windowsContract,
      repositoryRoot: winRoot,
      outputRoot: join(winRoot, "desktop", "dist", "mismatched"),
      packagedApplication: winPackagedApplication,
      sourceGroups: [["electron", "desktop/main/index.mjs"]],
      rustBinaries: [winRustBinary],
      capture: mismatchedCapture,
    }), "mismatched PDB identity rejected").rejects.toThrow("PDB identity");

    // Upload credentials stay out of plans and the packaged tree is audited.
    const auditRoot = await mkdtemp(join(tmpdir(), "relayer-telemetry-package-audit-"));
    await writeFile(join(auditRoot, "app.asar"), "sealed application bytes", "utf8");
    await expect(assertCredentialAbsentFromTree({ root: auditRoot, credential: "ci-only-secret-token" }), "clean tree passes audit").resolves.toBeUndefined();
    await writeFile(join(auditRoot, "bad.bin"), "prefix-ci-only-secret-token-suffix", "utf8");
    await expect(assertCredentialAbsentFromTree({ root: auditRoot, credential: "ci-only-secret-token" }), "embedded credential fails audit")
      .rejects.toThrow("packaged application bytes");

    // The pinned Sentry CLI plan is created only for exact Preview or Stable CI authority.
    const manifest = {
      schema: "relayer.desktop-telemetry-artifacts/v1",
      release: `ai.relayer.desktop@0.2.17+${commit}`,
      version: "0.2.17",
      sourceCommit: commit,
      candidateChannel: "preview",
      target: "macos-arm64",
      platform: "macos",
      architecture: "arm64",
      packagedApplication: "mac-arm64/Relayer.app",
      sourceMaps: [{
        component: "electron",
        module: "desktop/main/index.mjs",
        path: "source-maps/desktop/main/index.mjs.map",
        size: 2,
        sha256: "a".repeat(64),
        source: { path: "source-maps/desktop/main/index.mjs", size: 2, sha256: "c".repeat(64) },
      }],
      debugArtifacts: [{ path: "debug/relayer-app-server.dSYM/Contents/Resources/DWARF/relayer-app-server", size: 2, sha256: "b".repeat(64) }],
      nativeDebugIdentities: [{
        binary: "bin/relayer-app-server",
        debug: "debug/relayer-app-server.dSYM",
        debugId: "12345678-1234-1234-1234-123456789abc",
      }],
    };
    const environment = {
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: commit,
      RELAYER_DESKTOP_RELEASE: "1",
      RELAYER_DESKTOP_CHANNEL: "preview",
      RELAYER_DESKTOP_TARGET: "macos-arm64",
      RELAYER_DESKTOP_SOURCE_COMMIT: commit,
      SENTRY_AUTH_TOKEN: "ci-only-secret-token",
      SENTRY_CLI_BINARY: "/opt/relayer/node_modules/.bin/sentry-cli",
      SENTRY_ORG: "relayer-labs-llc",
      SENTRY_PROJECT: "graphcomplete-desktop",
    };
    const plan = createDesktopTelemetryUploadPlan({ manifest, environment, artifactsRoot: "/tmp/telemetry" });
    expect(plan, "four pinned upload steps").toHaveLength(4);
    expect(plan.flatMap((step) => step.args), "release identity uploaded").toContain(manifest.release);
    expect(JSON.stringify(plan), "auth token never appears in the plan").not.toContain(environment.SENTRY_AUTH_TOKEN);
    expect(plan.every((step) => step.command === environment.SENTRY_CLI_BINARY), "pinned sentry-cli binary").toBe(true);
    // sentry-cli scopes --org/--project to the subcommand. Passing them as
    // global options ahead of it aborts with "unexpected argument '--org'",
    // which only surfaces during a signed release, so pin the order here.
    expect(plan.map((step) => step.args.slice(0, 4)), "subcommand-scoped option order").toEqual([
      ["releases", "new", "--org", environment.SENTRY_ORG],
      ["sourcemaps", "upload", "--org", environment.SENTRY_ORG],
      ["debug-files", "upload", "--org", environment.SENTRY_ORG],
      ["releases", "finalize", "--org", environment.SENTRY_ORG],
    ]);
    for (const step of plan) {
      expect(step.args[step.args.indexOf("--org") + 1], "org scoped to subcommand").toBe(environment.SENTRY_ORG);
      expect(step.args[step.args.indexOf("--project") + 1], "project scoped to subcommand").toBe(environment.SENTRY_PROJECT);
      expect(step.args.findIndex((argument) => argument.startsWith("--")), "no global options before the subcommand").toBeGreaterThan(1);
    }
    expect(() => createDesktopTelemetryUploadPlan({
      manifest,
      environment: { ...environment, RELAYER_DESKTOP_CHANNEL: "stable" },
      artifactsRoot: "/tmp/telemetry",
    }), "Stable CI authority accepted").not.toThrow();

    const rejectedPlans = [
      ["development channel", { manifest, environment: { ...environment, RELAYER_DESKTOP_CHANNEL: "development" }, artifactsRoot: "/tmp/telemetry" }, "Preview or Stable"],
      ["missing auth token", { manifest, environment: { ...environment, SENTRY_AUTH_TOKEN: "" }, artifactsRoot: "/tmp/telemetry" }, "SENTRY_AUTH_TOKEN"],
      ["mismatched source commit", { manifest, environment: { ...environment, GITHUB_SHA: "f".repeat(40) }, artifactsRoot: "/tmp/telemetry" }, "source commit"],
      ["unapproved Sentry project", { manifest, environment: { ...environment, SENTRY_PROJECT: "other-project" }, artifactsRoot: "/tmp/telemetry" }, "approved Sentry project"],
      ["mismatched target tuple", { manifest: { ...manifest, architecture: "x64" }, environment, artifactsRoot: "/tmp/telemetry" }, "target tuple"],
      ["invalid manifest shape", { manifest: { ...manifest, extra: true }, environment, artifactsRoot: "/tmp/telemetry" }, "manifest is invalid"],
    ];
    expect(rejectedPlans, "upload plan rejection inventory").toHaveLength(6);
    for (const [label, input, message] of rejectedPlans) {
      expect(() => createDesktopTelemetryUploadPlan(input), label).toThrow(message);
    }
  }, 30_000);
});
