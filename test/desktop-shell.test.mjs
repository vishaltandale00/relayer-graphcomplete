import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CodexCredentialAdapter } from "../desktop/main/credentials/codex-credential-adapter.mjs";
import { CredentialAdapter } from "../desktop/main/credentials/credential-adapter.mjs";
import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import { createDesktopUpdater } from "../desktop/main/services/updater.mjs";
import {
  DESKTOP_UPDATE_BASE_URL,
  packagedDesktopReleaseMetadata,
} from "../desktop/shared/release-metadata.mjs";
import { createDesktopBuilderConfig } from "../desktop/packaging/electron-builder.mjs";
import {
  DESKTOP_RELEASE,
  resolveDesktopReleaseContract,
} from "../desktop/release/contract.mjs";
import {
  desktopReleaseArtifactNames,
  verifyDesktopReleaseEvidence,
  writeDesktopReleaseEvidence,
} from "../desktop/release/artifacts.mjs";
import { finalizeDesktopUpdateArtifact } from "../desktop/release/finalize-update-artifact.mjs";
import {
  buildPutObjectArgs,
  classifyPreviewPointer,
  createPreviewPublicationPlan,
  preparePreviewManifest,
  publishDesktopPreview,
  validatePreviewCandidate,
  validatePreviewPublicationProvenance,
} from "../desktop/release/publish-preview.mjs";
import { addLocalThread, interactionForThread, responseNodesForThread } from "../desktop/renderer/src/thread-model.js";

describe("desktop skeleton", () => {
  it("exposes Codex setup, New thread, and updates without a harness selector", async () => {
    const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
    const desktopMain = await readFile(new URL("../desktop/main/index.mjs", import.meta.url), "utf8");
    const packageManifest = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const desktopManifest = await readFile(new URL("../desktop/package.json", import.meta.url), "utf8");
    const packaging = await readFile(new URL("../desktop/packaging/electron-builder.mjs", import.meta.url), "utf8");
    const prd = await readFile(new URL("../docs/prd/index.html", import.meta.url), "utf8");
    const prdServer = await readFile(new URL("../docs/prd/server.mjs", import.meta.url), "utf8");
    expect(html).toContain("Connect a provider");
    expect(html).toContain("Codex");
    expect(html).toContain("New thread");
    expect(html).toContain("Application updates");
    expect(html).toContain('id="appearanceSelect"');
    expect(html).toContain('id="collapseSidebar"');
    expect(html).toContain('id="scopeButton"');
    expect(html).toContain('id="scopeMenu"');
    expect(html).toContain('id="disconnectCodex"');
    expect(html).toContain('id="updateChannel"');
    expect(html).toContain("relayer-logo");
    expect(html).toContain('class="settings-view hidden"');
    expect(html).toContain('type="module" src="./src/main.js"');
    expect(html).not.toContain("<dialog");
    expect(html.toLowerCase()).not.toContain("harness selector");
    expect(desktopMain).not.toContain("PrimeAgentThreadRunner");
    expect(desktopMain).not.toContain("RelayerAppServer");
    expect(packageManifest).not.toContain("@openai/codex-sdk");
    expect(desktopManifest).not.toContain("prime-agent");
    expect(desktopManifest).not.toContain("@openai/codex-sdk");
    expect(desktopManifest).toContain('"main": "main/index.mjs"');
    expect(JSON.parse(packageManifest).workspaces).toEqual(["desktop"]);
    expect(JSON.parse(packageManifest).devDependencies).not.toHaveProperty("@openai/codex");
    expect(JSON.parse(packageManifest).devDependencies).not.toHaveProperty("electron-updater");
    expect(packageManifest).toContain("desktop/packaging/electron-builder.mjs");
    expect(packaging).toContain('"macos/entitlements.mac.plist"');
    expect(packaging).toContain('"!packaging/**/*"');
    expect(prd).toContain('src="assets/product-walkthrough.html"');
    expect(prd).toContain('document: \'docs/prd/index.html\'');
    expect(prdServer).toContain('join(prdDirectory, "comments.json")');
    expect(packageManifest).not.toContain('"marked"');
  });

  it("covers the provider authorization lifecycle and its retryable edge cases in one scenario", async () => {
    const methods = [];
    const accountEvents = [];
    let loginNumber = 0;
    let account = null;
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill: vi.fn() });
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(String(chunk));
      methods.push(request.method);
      if (request.method === "never-respond") { callback(); return; }
      const result = request.method === "account/login/start"
        ? { loginId: `login-${++loginNumber}`, authUrl: `https://example.test/login-${loginNumber}` }
        : request.method === "account/login/cancel" ? { status: "canceled" }
          : request.method === "account/read" ? { account }
            : {};
      if (request.id !== undefined) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
      callback();
    } });
    const client = new CodexCredentialAdapter({
      environment: { RELAYER_CODEX_BINARY: "/usr/bin/true", PATH: "" },
      spawnProcess: () => child,
      onAccountChanged: (event) => accountEvents.push(event),
    });

    expect(client).toBeInstanceOf(CredentialAdapter);
    expect(client.providerId).toBe("codex");

    expect(await client.account()).toEqual({ status: "disconnected", account: null });

    const initial = client.login();
    const replacement = client.login();

    expect((await initial).loginId).toBe("login-1");
    expect((await replacement).loginId).toBe("login-2");
    expect(methods).toEqual([
      "initialize", "initialized", "account/read", "account/login/start",
      "account/login/cancel", "account/login/start",
    ]);

    child.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { loginId: "login-1" } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(accountEvents).toEqual([]);
    expect((await client.login()).loginId).toBe("login-3");
    expect(methods.slice(-2)).toEqual(["account/login/cancel", "account/login/start"]);

    account = { email: "person@example.test", planType: "test" };
    child.stdout.write(`${JSON.stringify({ method: "account/login/completed", params: { loginId: "login-3" } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    expect(accountEvents.at(-1)).toMatchObject({ status: "changed" });
    expect(await client.account()).toEqual({ status: "connected", account });

    await expect(client.request("never-respond", {}, 5)).rejects.toThrow("Codex request timed out");
    const interrupted = client.request("never-respond", {}, 1_000);
    child.emit("exit", 1, null);
    await expect(interrupted).rejects.toThrow("Codex app-server stopped");
    expect(accountEvents.at(-1)).toMatchObject({ status: "unavailable" });

    let failedStarts = 0;
    const failingClient = new CodexCredentialAdapter({
      environment: { RELAYER_CODEX_BINARY: "/usr/bin/true", PATH: "" },
      spawnProcess: () => {
        failedStarts += 1;
        const failedChild = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          killed: false,
        });
        failedChild.kill = vi.fn(() => { failedChild.killed = true; });
        failedChild.stdin = new Writable({ write(chunk, _encoding, callback) {
          const request = JSON.parse(String(chunk));
          if (request.id !== undefined) {
            queueMicrotask(() => failedChild.stdout.write(`${JSON.stringify({
              id: request.id,
              error: { message: "initialize failed" },
            })}\n`));
          }
          callback();
        } });
        return failedChild;
      },
    });
    expect(await failingClient.account()).toMatchObject({ status: "unavailable", error: "initialize failed" });
    expect(await failingClient.account()).toMatchObject({ status: "unavailable", error: "initialize failed" });
    expect(failedStarts).toBe(2);
  });

  it("drives the packaged update lifecycle through one state service", async () => {
    expect(packagedDesktopReleaseMetadata({
      relayerArtifactMode: "release",
      relayerUpdateChannel: "preview",
      relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL,
    })).toEqual({ channel: "preview", updateBaseUrl: DESKTOP_UPDATE_BASE_URL });
    expect(packagedDesktopReleaseMetadata({
      relayerArtifactMode: "release",
      relayerUpdateChannel: "stable",
      relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL,
    })).toEqual({ channel: "stable", updateBaseUrl: DESKTOP_UPDATE_BASE_URL });
    for (const metadata of [
      { relayerArtifactMode: "development", relayerUpdateChannel: "preview", relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL },
      { relayerArtifactMode: "release", relayerUpdateChannel: "beta", relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL },
      { relayerArtifactMode: "release", relayerUpdateChannel: "preview", relayerUpdateBaseUrl: "https://example.test" },
    ]) {
      expect(packagedDesktopReleaseMetadata(metadata)).toBeNull();
    }

    const autoUpdater = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      setFeedURL: vi.fn(),
      quitAndInstall: vi.fn(),
    });
    const states = [];
    const updater = createDesktopUpdater({
      autoUpdater,
      app: { isPackaged: true, getVersion: () => "0.1.0" },
      updateBaseUrl: "https://updates.example.test/relayer",
      emit: (state) => states.push(state),
    });
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error("offline"));
    await expect(updater.check()).resolves.toMatchObject({ phase: "failed", error: "offline" });
    expect(updater.setChannel("preview")).toMatchObject({ phase: "idle", channel: "preview" });
    autoUpdater.emit("checking-for-update");
    expect(() => updater.setChannel("stable")).toThrow("Finish the current update");
    autoUpdater.emit("update-available", { version: "0.1.1" });
    expect(() => updater.setChannel("stable")).toThrow("Finish the current update");
    await updater.download();
    autoUpdater.emit("update-downloaded", { version: "0.1.1" });
    updater.install();

    expect(states.map((state) => state.phase)).toEqual(["failed", "idle", "checking", "available", "ready"]);
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({ channel: "beta" }));
    expect(autoUpdater.allowDowngrade).toBe(false);
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("enforces one signed desktop release contract and seals its candidate artifacts", async () => {
    const releaseWorkflow = await readFile(new URL("../.github/workflows/desktop-signed-preview.yml", import.meta.url), "utf8");
    expect(releaseWorkflow).toContain('if: startsWith(github.ref, \'refs/tags/desktop-v\')');
    expect(releaseWorkflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main');
    expect(releaseWorkflow).toContain("environment:\n      name: desktop-update-preview");
    const releaseEnvironment = {
      RELAYER_DESKTOP_RELEASE: "1",
      RELAYER_DESKTOP_CHANNEL: "preview",
      RELAYER_DESKTOP_UPDATE_BASE_URL: DESKTOP_RELEASE.updateBaseUrl,
      RELAYER_DESKTOP_SIGN_IDENTITY: "Developer ID Application: VISHAL TANDALE (NZ253AL7U6)",
      APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
      APPLE_API_KEY_ID: "TESTKEY",
      APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
    };
    const sourceCommit = "a".repeat(40);
    const contract = resolveDesktopReleaseContract({
      environment: releaseEnvironment,
      version: "0.2.0",
      sourceCommit,
    });
    expect(contract).toMatchObject({
      release: true,
      appId: "ai.relayer.desktop",
      version: "0.2.0",
      architecture: "arm64",
      minimumMacOSVersion: "13.0.0",
      channelName: "preview",
      providerChannel: "beta",
      manifestName: "beta-mac.yml",
      sourceCommit,
      appleTeamId: "NZ253AL7U6",
    });
    const builder = createDesktopBuilderConfig(contract);
    expect(builder).toMatchObject({
      appId: "ai.relayer.desktop",
      productName: "Relayer",
      forceCodeSigning: true,
      afterSign: "desktop/release/verify-macos-app.mjs",
      mac: {
        identity: "VISHAL TANDALE (NZ253AL7U6)",
        minimumSystemVersion: "13.0.0",
        hardenedRuntime: true,
        notarize: true,
      },
      publish: [{ provider: "generic", url: DESKTOP_RELEASE.updateBaseUrl, channel: "beta" }],
    });
    // Electron 43's Squirrel.Mac implementation rejects valid numeric versions when
    // this native flag is enabled. Version monotonicity remains enforced by the
    // application updater above and by Preview publication.
    expect(builder.mac.extendInfo).toBeUndefined();

    const development = resolveDesktopReleaseContract({ environment: {}, version: "0.2.0" });
    expect(development).toMatchObject({
      release: false,
      appId: "ai.relayer.desktop.development",
      productName: "Relayer Dev",
      channelName: "development",
      signingMode: "unsigned",
    });

    const invalidCases = [
      [{ ...releaseEnvironment, RELAYER_DESKTOP_CHANNEL: "nightly" }, "0.2.0", sourceCommit, "stable or preview"],
      [releaseEnvironment, "0.1.0", sourceCommit, "0.2.0 or newer"],
      [{ ...releaseEnvironment, RELAYER_DESKTOP_UPDATE_BASE_URL: "https://example.test" }, "0.2.0", sourceCommit, "must be exactly"],
      [{ ...releaseEnvironment, RELAYER_DESKTOP_SIGN_IDENTITY: "Apple Development: Example" }, "0.2.0", sourceCommit, "Developer ID Application"],
      [{ ...releaseEnvironment, APPLE_API_KEY: "" }, "0.2.0", sourceCommit, "notarytool"],
      [{ ...releaseEnvironment, CSC_LINK: "/tmp/certificate.p12" }, "0.2.0", sourceCommit, "provided together"],
      [releaseEnvironment, "0.2.0", "short", "40-character"],
    ];
    for (const [environment, version, commit, message] of invalidCases) {
      expect(() => resolveDesktopReleaseContract({ environment, version, sourceCommit: commit })).toThrow(message);
    }

    const directory = await mkdtemp(join(tmpdir(), "relayer-release-contract-"));
    try {
      const names = desktopReleaseArtifactNames(contract);
      const dmg = Buffer.from("signed-notarized-dmg-fixture");
      const originalZip = Buffer.from("electron-builder-zip-fixture");
      const finalZip = Buffer.from("one-app-final-update-zip-fixture");
      const originalZipSha512 = createHash("sha512").update(originalZip).digest("base64");
      const dmgSha512 = createHash("sha512").update(dmg).digest("base64");
      await Promise.all([
        writeFile(join(directory, names.dmg), dmg),
        writeFile(join(directory, names.zip), originalZip),
        writeFile(join(directory, names.manifest), [
          `version: ${contract.version}`,
          "files:",
          `  - url: ${names.zip}`,
          `    sha512: ${originalZipSha512}`,
          `    size: ${originalZip.length}`,
          `  - url: ${names.dmg}`,
          `    sha512: ${dmgSha512}`,
          `    size: ${dmg.length}`,
          `path: ${names.zip}`,
          `sha512: ${originalZipSha512}`,
          "",
        ].join("\n")),
      ]);
      await finalizeDesktopUpdateArtifact({
        appPath: join(directory, "Relayer.app"),
        contract,
        distRoot: directory,
        execute: async (_command, args) => {
          await writeFile(args.at(-1), finalZip);
          return { stdout: "", stderr: "" };
        },
        createBlockMap: async ({ outputPath }) => writeFile(outputPath, "blockmap-fixture"),
      });
      const written = await writeDesktopReleaseEvidence({ distRoot: directory, contract });
      expect(written.receipt).toMatchObject({
        version: "0.2.0",
        channel: "preview",
        sourceCommit,
        appleTeamId: "NZ253AL7U6",
      });
      expect(written.zip.sha512).toBe(createHash("sha512").update(finalZip).digest("base64"));
      await expect(verifyDesktopReleaseEvidence({ distRoot: directory, contract })).resolves.toMatchObject({
        names: { receipt: names.receipt, checksums: names.checksums },
      });
      await writeFile(join(directory, names.checksums), "tampered\n");
      await expect(verifyDesktopReleaseEvidence({ distRoot: directory, contract })).rejects.toThrow("checksum manifest");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("gates Preview publication on one immutable candidate and one monotonic pointer", () => {
    const version = "0.2.0";
    const sourceCommit = "b".repeat(40);
    const evidenceFor = (name, content) => ({
      name,
      size: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      sha512: createHash("sha512").update(content).digest("base64"),
    });
    const prefix = `Relayer-${version}-mac-arm64`;
    const dmg = evidenceFor(`${prefix}.dmg`, "notarized-dmg");
    const zip = evidenceFor(`${prefix}.zip`, "notarized-update-zip");
    const dmgBlockmap = evidenceFor(`${dmg.name}.blockmap`, "dmg-blockmap");
    const zipBlockmap = evidenceFor(`${zip.name}.blockmap`, "zip-blockmap");
    const releaseReceipt = {
      schemaVersion: 1,
      product: "Relayer",
      appId: DESKTOP_RELEASE.productionAppId,
      version,
      architecture: DESKTOP_RELEASE.architecture,
      minimumMacOSVersion: DESKTOP_RELEASE.minimumMacOSVersion,
      channel: "preview",
      manifest: "beta-mac.yml",
      updateBaseUrl: DESKTOP_RELEASE.updateBaseUrl,
      sourceCommit,
      appleTeamId: DESKTOP_RELEASE.appleTeamId,
      artifacts: [dmg, zip],
    };
    const checksumText = `${dmg.sha256}  ${dmg.name}\n${zip.sha256}  ${zip.name}\n`;
    const evidence = [
      dmg,
      dmgBlockmap,
      zip,
      zipBlockmap,
      evidenceFor(`${prefix}-SHA256SUMS.txt`, checksumText),
      evidenceFor(`${prefix}-RELEASE.json`, JSON.stringify(releaseReceipt)),
    ];

    expect(validatePreviewPublicationProvenance({
      GITHUB_SHA: sourceCommit,
      GITHUB_REF_NAME: `desktop-v${version}`,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    }, version)).toEqual({ sourceCommit, workflowRunId: "123", workflowRunAttempt: "2" });
    expect(() => validatePreviewPublicationProvenance({
      GITHUB_SHA: sourceCommit,
      GITHUB_REF_NAME: "desktop-v0.2.1",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    }, version)).toThrow(`desktop-v${version}`);

    expect(() => validatePreviewCandidate({
      releaseReceipt,
      checksumText,
      version,
      sourceCommit,
      artifactEvidence: evidence,
    })).not.toThrow();
    expect(() => validatePreviewCandidate({
      releaseReceipt,
      checksumText: checksumText.replace(dmg.sha256, "0".repeat(64)),
      version,
      sourceCommit,
      artifactEvidence: evidence,
    })).toThrow("checksum manifest");

    const manifestText = [
      `version: ${version}`,
      "files:",
      `  - url: ${zip.name}`,
      `    sha512: ${zip.sha512}`,
      `    size: ${zip.size}`,
      `    blockMapSize: ${zipBlockmap.size}`,
      `  - url: ${dmg.name}`,
      `    sha512: ${dmg.sha512}`,
      `    size: ${dmg.size}`,
      `    blockMapSize: ${dmgBlockmap.size}`,
      `path: ${zip.name}`,
      `sha512: ${zip.sha512}`,
      "",
    ].join("\n");
    const preparedManifest = preparePreviewManifest({ manifestText, version, artifactEvidence: evidence });
    expect(preparedManifest).toContain(`releases/${version}/${zip.name}`);
    expect(preparedManifest).toContain(`releases/${version}/${dmg.name}`);
    expect(createPreviewPublicationPlan({ version, evidence })).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: zip.name, key: `desktop/macos/arm64/releases/${version}/${zip.name}` }),
      expect.objectContaining({ name: dmg.name, key: `desktop/macos/arm64/releases/${version}/${dmg.name}` }),
    ]));
    expect(buildPutObjectArgs({
      bucket: "updates",
      key: `desktop/macos/arm64/releases/${version}/${zip.name}`,
      filePath: `/tmp/${zip.name}`,
      evidence: zip,
      ifNoneMatch: true,
      cacheControl: "immutable",
      sourceCommit,
    })).toEqual(expect.arrayContaining(["--if-none-match", "*", "--checksum-sha256"]));

    expect(classifyPreviewPointer({ version, manifestText: preparedManifest })).toEqual({ recovery: false });
    expect(classifyPreviewPointer({
      currentVersion: version,
      currentContent: preparedManifest,
      version,
      manifestText: preparedManifest,
    })).toEqual({ recovery: true });
    expect(() => classifyPreviewPointer({
      currentVersion: version,
      currentContent: "different bytes",
      version,
      manifestText: preparedManifest,
    })).toThrow("cannot be replaced");
    expect(() => classifyPreviewPointer({
      currentVersion: "0.2.1",
      currentContent: "newer",
      version,
      manifestText: preparedManifest,
    })).toThrow("must be newer");
  });

  it("publishes one Preview candidate atomically and recovers without mutating live bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-preview-publication-"));
    try {
      const { version } = JSON.parse(await readFile(new URL("../desktop/package.json", import.meta.url), "utf8"));
      const sourceCommit = "c".repeat(40);
      const prefix = `Relayer-${version}-mac-arm64`;
      const contents = new Map([
        [`${prefix}.dmg`, Buffer.from("signed-notarized-dmg")],
        [`${prefix}.dmg.blockmap`, Buffer.from("dmg-blockmap")],
        [`${prefix}.zip`, Buffer.from("signed-notarized-update-zip")],
        [`${prefix}.zip.blockmap`, Buffer.from("zip-blockmap")],
      ]);
      const evidenceFor = (name) => {
        const content = contents.get(name);
        return {
          name,
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
          sha512: createHash("sha512").update(content).digest("base64"),
        };
      };
      const dmg = evidenceFor(`${prefix}.dmg`);
      const zip = evidenceFor(`${prefix}.zip`);
      const dmgBlockmap = evidenceFor(`${prefix}.dmg.blockmap`);
      const zipBlockmap = evidenceFor(`${prefix}.zip.blockmap`);
      const checksumText = `${dmg.sha256}  ${dmg.name}\n${zip.sha256}  ${zip.name}\n`;
      const releaseReceipt = {
        schemaVersion: 1,
        product: DESKTOP_RELEASE.productName,
        appId: DESKTOP_RELEASE.productionAppId,
        version,
        architecture: DESKTOP_RELEASE.architecture,
        minimumMacOSVersion: DESKTOP_RELEASE.minimumMacOSVersion,
        channel: "preview",
        manifest: "beta-mac.yml",
        updateBaseUrl: DESKTOP_RELEASE.updateBaseUrl,
        sourceCommit,
        appleTeamId: DESKTOP_RELEASE.appleTeamId,
        artifacts: [dmg, zip],
      };
      contents.set(`${prefix}-SHA256SUMS.txt`, Buffer.from(checksumText));
      contents.set(`${prefix}-RELEASE.json`, Buffer.from(JSON.stringify(releaseReceipt)));
      await Promise.all([...contents].map(([name, content]) => writeFile(join(directory, name), content)));
      await writeFile(join(directory, "beta-mac.yml"), [
        `version: ${version}`,
        "files:",
        `  - url: ${zip.name}`,
        `    sha512: ${zip.sha512}`,
        `    size: ${zip.size}`,
        `    blockMapSize: ${zipBlockmap.size}`,
        `  - url: ${dmg.name}`,
        `    sha512: ${dmg.sha512}`,
        `    size: ${dmg.size}`,
        `    blockMapSize: ${dmgBlockmap.size}`,
        `path: ${zip.name}`,
        `sha512: ${zip.sha512}`,
        "",
      ].join("\n"));

      const objects = new Map();
      const writes = [];
      const argument = (args, name) => args[args.indexOf(name) + 1];
      const execute = async (command, args) => {
        expect(command).toBe("aws");
        const operation = args[1];
        const key = argument(args, "--key");
        if (operation === "head-object") {
          const object = objects.get(key);
          if (!object) {
            const error = new Error("Not Found");
            error.stderr = "404 Not Found";
            throw error;
          }
          return { stdout: JSON.stringify({
            ContentLength: object.body.length,
            Metadata: object.metadata,
            ChecksumSHA256: object.checksumSha256,
            ETag: object.etag,
          }) };
        }
        if (operation === "get-object") {
          const object = objects.get(key);
          if (!object) throw new Error(`missing object ${key}`);
          await writeFile(args.at(-1), object.body);
          return { stdout: "{}" };
        }
        if (operation !== "put-object") throw new Error(`unexpected AWS operation ${operation}`);
        const existing = objects.get(key);
        if (args.includes("--if-none-match") && existing) throw new Error("PreconditionFailed");
        if (args.includes("--if-match") && existing?.etag !== argument(args, "--if-match")) {
          throw new Error("PreconditionFailed");
        }
        const body = await readFile(argument(args, "--body"));
        const metadata = Object.fromEntries(argument(args, "--metadata").split(",").map((item) => item.split("=")));
        const object = {
          body,
          metadata,
          checksumSha256: argument(args, "--checksum-sha256"),
          etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
        };
        objects.set(key, object);
        writes.push(key);
        return { stdout: JSON.stringify({ ETag: object.etag }) };
      };
      let failPublicArtifact = true;
      const fetchImpl = async (url) => {
        const parsed = new URL(url);
        const key = parsed.pathname.replace(/^\//, "");
        if (failPublicArtifact && key.endsWith(`/${zip.name}`)) {
          return new Response("temporarily unavailable", { status: 503 });
        }
        const object = objects.get(key);
        return object ? new Response(object.body, { status: 200 }) : new Response("missing", { status: 404 });
      };
      const environment = {
        GITHUB_SHA: sourceCommit,
        GITHUB_REF_NAME: `desktop-v${version}`,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
      };
      const pointerKey = "desktop/macos/arm64/beta-mac.yml";
      const historyKey = `private/history/beta/${version}/beta-mac.yml`;
      const receiptKey = `private/receipts/preview/${version}.json`;

      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment,
        execute,
        fetchImpl,
      })).rejects.toThrow("Public update object is unavailable");
      expect(objects.has(pointerKey)).toBe(false);
      expect(objects.has(receiptKey)).toBe(false);

      failPublicArtifact = false;
      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment,
        execute,
        fetchImpl,
      })).resolves.toMatchObject({ receipt: { version, sourceCommit } });
      const releaseWriteIndexes = writes
        .map((key, index) => key.startsWith(`desktop/macos/arm64/releases/${version}/`) ? index : -1)
        .filter((index) => index >= 0);
      expect(writes.indexOf(pointerKey)).toBeGreaterThan(Math.max(...releaseWriteIndexes));
      expect(writes.indexOf(pointerKey)).toBeGreaterThan(writes.indexOf(historyKey));
      expect(writes.indexOf(receiptKey)).toBeGreaterThan(writes.indexOf(pointerKey));

      const writesAfterSuccess = [...writes];
      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment: { ...environment, GITHUB_RUN_ATTEMPT: "2" },
        execute,
        fetchImpl,
      })).resolves.toMatchObject({ receipt: { workflowRunAttempt: "1" } });
      expect(writes).toEqual(writesAfterSuccess);

      objects.get(`desktop/macos/arm64/releases/${version}/${zip.name}`).metadata.sha256 = "0".repeat(64);
      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment: { ...environment, GITHUB_RUN_ATTEMPT: "3" },
        execute,
        fetchImpl,
      })).rejects.toThrow("already exists with different evidence");
      expect(writes).toEqual(writesAfterSuccess);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps settings writes atomic and local thread graph state scoped to its owning thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-desktop-test-"));
    try {
      const settings = createSettingsStore(directory);
      await settings.write({ appearance: "light", updateChannel: "preview" });
      expect(await settings.read()).toEqual({ appearance: "light", updateChannel: "preview" });
      expect(await readdir(directory)).toEqual(["desktop-settings.json"]);

      const state = { projects: [], threads: [], nodes: [], edges: [], status: "idle" };
      let nextId = 0;
      const createId = () => `id-${++nextId}`;
      const first = addLocalThread(state, {
        selectedScope: { kind: "standalone" },
        prompt: "first prompt",
        title: "First",
        createId,
      });
      const second = addLocalThread(state, {
        selectedScope: { kind: "standalone" },
        prompt: "second prompt",
        title: "Second",
        createId,
      });
      expect(interactionForThread(state, first).summary).toBe("first prompt");
      expect(interactionForThread(state, second).summary).toBe("second prompt");

      state.nodes.push({ id: "response", metadata: { relayer: { responseLayerOwnerNodeId: first.rootNodeId } } });
      state.status = "submitted";
      expect(responseNodesForThread(state, first)).toEqual([]);
      state.status = "accepted";
      expect(responseNodesForThread(state, first).map((node) => node.id)).toEqual(["response"]);
      expect(responseNodesForThread(state, second)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
