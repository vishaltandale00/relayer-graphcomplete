import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { digestHarnessConfiguration } from "../packages/harness-host/src/configuration.ts";
import {
  CodexCredentialAdapter,
  findCodexExecutable,
} from "../desktop/main/credentials/codex-credential-adapter.mjs";
import { CredentialAdapter } from "../desktop/main/credentials/credential-adapter.mjs";
import { RelayerAppServerService } from "../desktop/main/services/relayer-app-server.mjs";
import { GraphCompleteRuntimeService } from "../desktop/main/services/graphcomplete-runtime.mjs";
import {
  DEFAULT_DESKTOP_HARNESS_CONFIGURATION,
  resolveDesktopHarnessConfiguration,
} from "../desktop/main/services/desktop-harness-configuration.mjs";
import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import { createCanaryEvidenceLog } from "../desktop/main/services/canary-evidence-log.mjs";
import {
  createDesktopUpdater,
  desktopUpdateSupportsSystem,
  resolveUpdateChannel,
} from "../desktop/main/services/updater.mjs";
import { claimPrimaryDesktopInstance } from "../desktop/main/single-instance.mjs";
import {
  DESKTOP_UPDATE_BASE_URL,
  DESKTOP_UPDATE_BASE_URLS,
  packagedDesktopReleaseMetadata,
} from "../desktop/shared/release-metadata.mjs";
import { createDesktopBuilderConfig } from "../desktop/packaging/electron-builder.mjs";
import { ACTIVE_PROVIDER_ADAPTER_MODULES } from "../desktop/main/providers/provider-adapter-registry.mjs";
import { verifyBundledAppServer, verifyPackagedLadybugNotices } from "../desktop/packaging/verify-bundled-app-server.mjs";
import { ladybugNoticesExtraResource } from "../desktop/packaging/ladybug-notices.mjs";
import { desktopTarget } from "../desktop/shared/target.mjs";
import {
  DESKTOP_RELEASE,
  DESKTOP_RELEASE_TARGETS,
  resolveDesktopReleaseContract,
} from "../desktop/release/contract.mjs";
import {
  desktopReleaseArtifactNames,
  verifyDesktopReleaseEvidence,
  writeDesktopReleaseEvidence,
} from "../desktop/release/artifacts.mjs";
import { desktopReleaseAppPath } from "../desktop/release/app-path.mjs";
import { finalizeDesktopUpdateArtifact } from "../desktop/release/finalize-update-artifact.mjs";
import { createDesktopCanaryEvidence, deriveDesktopCanaryTrace } from "../desktop/release/canary-evidence.mjs";
import {
  parseDesktopPreviewCandidateTag,
  resolveDesktopPreviewCandidateRun,
  validateDesktopPreviewCandidateRun,
  writeDesktopPreviewCandidateOutputs,
} from "../desktop/release/preview-candidate-run.mjs";
import { verifyWindowsSignatures, windowsApplicationExecutables } from "../desktop/release/verify-windows-app.mjs";
import {
  buildPutObjectArgs,
  classifyPreviewPointer,
  createPreviewPublicationPlan,
  preparePreviewManifest,
  publishDesktopPreview,
  validatePreviewCandidate,
  validatePreviewPublicationProvenance,
} from "../desktop/release/publish-preview.mjs";
import {
  classifyStablePointer,
  promoteDesktopStable,
  validateCanaryEvidenceFile,
  validateStablePromotionProvenance,
} from "../desktop/release/promote-stable.mjs";
import { apiUrl } from "../desktop/renderer/src/api.js";
import {
  permissionPickerDisabled,
  permissionProfileDescription,
  resolvePermissionSelection,
} from "../desktop/renderer/src/permission-profile-model.js";
import { addLocalThread, interactionForThread, responseNodesForThread } from "../desktop/renderer/src/thread-model.js";
import {
  productWorkspaceMode,
  productWorkspaceNeedsRecreation,
  workspaceModeCapabilities,
} from "../desktop/renderer/src/product-workspace/model.js";
import { productWorkspaceMarkup } from "../desktop/renderer/src/product-workspace/view.js";
import { graphEdgeSegment, graphScreenPoint } from "../desktop/renderer/src/product-workspace/workspace.js";
import { isSafeMarkdownLink } from "../desktop/renderer/src/product-workspace/markdown.js";
import { evaluateDesktopReleaseAuthority } from "../scripts/audit-desktop-release-authority.mjs";

const WINDOWS_PUBLISHER_DN = "CN=Relayer Labs LLC, O=Relayer Labs LLC";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

describe("desktop skeleton", () => {
  it("uses electron-builder's architecture-specific unpacked application directories", () => {
    const distRoot = "/tmp/relayer-desktop-dist";
    const contract = { platform: "darwin", productName: "Relayer" };
    expect(desktopReleaseAppPath({ distRoot, contract: { ...contract, architecture: "arm64" } }))
      .toBe("/tmp/relayer-desktop-dist/mac-arm64/Relayer.app");
    expect(desktopReleaseAppPath({ distRoot, contract: { ...contract, architecture: "x64" } }))
      .toBe("/tmp/relayer-desktop-dist/mac/Relayer.app");
    expect(desktopReleaseAppPath({
      distRoot,
      contract: { platform: "win32", architecture: "x64", productName: "Relayer" },
    })).toBe("/tmp/relayer-desktop-dist/win-unpacked");
    expect(() => desktopReleaseAppPath({
      distRoot,
      contract: { ...contract, architecture: "riscv64" },
    })).toThrow("Unsupported macOS release architecture: riscv64.");
    expect(() => desktopReleaseAppPath({
      distRoot,
      contract: { platform: "win32", architecture: "arm64", productName: "Relayer" },
    })).toThrow("Unsupported Windows release architecture: arm64.");
    expect(() => desktopReleaseAppPath({
      distRoot,
      contract: { platform: "linux", architecture: "x64", productName: "Relayer" },
    })).toThrow("Unsupported desktop release platform: linux.");
  });

  it("allows a named development harness without changing the packaged harness", () => {
    expect(resolveDesktopHarnessConfiguration({ isPackaged: false, environment: {} }))
      .toBe(DEFAULT_DESKTOP_HARNESS_CONFIGURATION);
    expect(resolveDesktopHarnessConfiguration({
      isPackaged: false,
      environment: { RELAYER_DESKTOP_HARNESS_CONFIGURATION: "prime-agent-basic" },
    })).toBe("prime-agent-basic");
    expect(resolveDesktopHarnessConfiguration({
      isPackaged: true,
      environment: { RELAYER_DESKTOP_HARNESS_CONFIGURATION: "prime-agent-basic" },
    })).toBe(DEFAULT_DESKTOP_HARNESS_CONFIGURATION);
    expect(() => resolveDesktopHarnessConfiguration({
      isPackaged: false,
      environment: { RELAYER_DESKTOP_HARNESS_CONFIGURATION: "codex-basic-high" },
    })).toThrow("codex-basic-high is internal-only and cannot be loaded by Relayer Desktop");
    expect(() => resolveDesktopHarnessConfiguration({
      isPackaged: false,
      environment: { RELAYER_DESKTOP_HARNESS_CONFIGURATION: "../other" },
    })).toThrow("must be a harness configuration name");
  });

  it("moves graph world coordinates through a shared camera offset", () => {
    expect(graphScreenPoint({ x: 120, y: 80 }, { x: -35, y: 24 })).toEqual({ x: 85, y: 104 });
  });

  it("keeps one desktop authority and presents its window on later launches", () => {
    const handlers = new Map();
    let window;
    const app = {
      requestSingleInstanceLock: vi.fn(() => true),
      on: vi.fn((event, handler) => handlers.set(event, handler)),
      quit: vi.fn(),
    };
    const primary = claimPrimaryDesktopInstance({ app, getWindow: () => window });
    expect(primary).not.toBeNull();
    expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();

    handlers.get("second-instance")();
    window = {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    };
    expect(primary.presentPendingWindow()).toBe(true);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(primary.presentPendingWindow()).toBe(false);

    const secondaryApp = {
      requestSingleInstanceLock: vi.fn(() => false),
      on: vi.fn(),
      quit: vi.fn(),
    };
    expect(claimPrimaryDesktopInstance({ app: secondaryApp, getWindow: () => null })).toBeNull();
    expect(secondaryApp.quit).toHaveBeenCalledOnce();
    expect(secondaryApp.on).not.toHaveBeenCalled();
  });

  it("exposes Codex setup, separate permissions, and the advanced composer picker", async () => {
    const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
    const desktopMain = await readFile(new URL("../desktop/main/index.mjs", import.meta.url), "utf8");
    const packageManifest = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const desktopManifest = await readFile(new URL("../desktop/package.json", import.meta.url), "utf8");
    const vitestConfiguration = await readFile(new URL("../vitest.config.js", import.meta.url), "utf8");
    const packaging = await readFile(new URL("../desktop/packaging/electron-builder.mjs", import.meta.url), "utf8");
    const desktopWindow = await readFile(new URL("../desktop/main/window.mjs", import.meta.url), "utf8");
    const desktopIpc = await readFile(new URL("../desktop/main/ipc/register-ipc.mjs", import.meta.url), "utf8");
    const desktopPreload = await readFile(new URL("../desktop/preload/index.cjs", import.meta.url), "utf8");
    const rendererMain = await readFile(new URL("../desktop/renderer/src/main.js", import.meta.url), "utf8");
    const threads = await readFile(new URL("../desktop/renderer/src/threads.js", import.meta.url), "utf8");
    const prd = await readFile(new URL("../docs/prd/index.html", import.meta.url), "utf8");
    const prdTracker = prd.slice(
      prd.indexOf('<section class="status-tracker"'),
      prd.indexOf('</section>', prd.indexOf('<section class="status-tracker"')),
    );
    const prdServer = await readFile(new URL("../docs/prd/server.mjs", import.meta.url), "utf8");
    expect(html).toContain("Connect a provider");
    expect(html).toContain('id="providerSetupOptions"');
    expect(html).toContain('id="newProviderDefinition"');
    expect(html).toContain("New thread");
    expect(html).toContain("Application updates");
    expect(html).toContain('id="appearanceSelect"');
    expect(html).toContain('id="collapseSidebar"');
    expect(html).toContain('id="scopeButton"');
    expect(html).toContain('id="scopeMenu"');
    expect(html).toContain('id="permissionButton"');
    expect(html).toContain('id="permissionMenu"');
    expect(html).toContain('id="newModelControl"');
    expect(html).toContain('data-model-picker-tab="advanced"');
    expect(html).toContain('id="createThread" title="Create thread and send" disabled');
    expect(html).toContain('id="providerDefinitionList"');
    expect(html).toContain('id="updateChannel"');
    expect(html).toContain('id="newThreadShortcut"');
    expect(html).toContain('id="appearanceDescription"');
    expect(html).toContain('id="settingsTabs" role="tablist" aria-label="Settings sections" aria-orientation="vertical"');
    expect(html).toContain('<option value="advanced">Advanced</option>');
    expect(html.indexOf('id="settingsSidebarContent"')).toBeLessThan(html.indexOf('id="updateButton"'));
    expect(html).toContain("relayer-logo");
    expect(html).toContain('class="settings-view hidden"');
    expect(html).toContain('type="module" src="./src/main.js"');
    expect(html).toContain("connect-src 'self'");
    expect(html).not.toContain("http://127.0.0.1:*");
    expect(html).not.toContain('id="stopRun"');
    expect(html).not.toContain('id="retryRun"');
    expect(apiUrl("/api/state")).toBe("/api/state");
    expect(html).toContain('<dialog class="provider-dialog"');
    expect(html).toContain('aria-labelledby="providerDialogTitle"');
    expect(html.toLowerCase()).not.toContain("harness selector");
    expect(desktopMain).not.toContain("PrimeAgentThreadRunner");
    expect(rendererMain).toContain('import { bindComposerKeydown } from "./product-workspace/workspace.js";');
    expect(rendererMain).toContain('bindComposerKeydown($("#newThreadPrompt"), () => {');
    expect(rendererMain).toContain('openNewThreadModelPicker("model")');
    expect(desktopMain).toContain("RelayerAppServerService");
    expect(desktopMain.match(/issueErrorCapability,/gu)).toHaveLength(2);
    expect(desktopMain).toContain("authenticatedErrorReporting?.issueCapability({ component, processGeneration }) ?? null");
    expect(desktopMain).toContain("createDesktopAccountTelemetry");
    expect(desktopMain).toContain("graphRuntime.refreshErrorCapability()");
    expect(desktopMain).toContain("productServer?.refreshErrorCapability()");
    expect(desktopMain).toContain('allowHarnessOverride: !app.isPackaged && defaultHarnessConfiguration.startsWith("prime-agent-")');
    expect(desktopMain).toContain("productServer.start()");
    expect(desktopMain).toContain("productServer.close()");
    expect(desktopMain).not.toContain("startModelCatalogRefreshServer");
    expect(desktopMain).not.toContain("providerCatalogRefreshSession");
    expect(desktopPreload).not.toContain("provider-catalog/refresh");
    expect(desktopPreload).not.toContain("providerCatalogRefresh");
    expect(desktopPreload).toContain('export: (threadId) => ipcRenderer.invoke("relayer:conversation-export", threadId)');
    expect(desktopPreload).not.toContain("showSaveDialog");
    expect(desktopIpc).toContain('conversationExporter.save(threadId)');
    expect(desktopMain).toContain("Promise.allSettled");
    expect(desktopMain).toContain("settings.flush(),");
    expect(desktopMain).toContain("Relayer app server stopped");
    expect(desktopMain).toContain("app.isPackaged");
    expect(desktopWindow).toContain('window.webContents.on("will-navigate"');
    expect(desktopWindow).toContain('window.webContents.on("will-redirect"');
    expect(desktopIpc).toContain("onUpdateInstallFailure");
    expect(packageManifest).not.toContain("@openai/codex-sdk");
    expect(desktopManifest).toContain('"@earendil-works/pi-coding-agent"');
    expect(desktopManifest).toContain("file:../vendor/prime-agent/");
    expect(desktopManifest).not.toContain("@openai/codex-sdk");
    expect(JSON.parse(desktopManifest).dependencies).toMatchObject({ semver: "7.8.5", tar: "7.5.22" });
    expect(JSON.parse(desktopManifest).dependencies).not.toHaveProperty("@openai/codex");
    expect(desktopManifest).toContain('"main": "main/index.mjs"');
    expect(JSON.parse(packageManifest).workspaces).toEqual(["desktop", "packages/*"]);
    expect(JSON.parse(packageManifest).devDependencies).not.toHaveProperty("@openai/codex");
    expect(JSON.parse(packageManifest).devDependencies).not.toHaveProperty("electron-updater");
    expect(JSON.parse(packageManifest).scripts).toMatchObject({
      "predesktop:pack": "npm run prepare:desktop-runtime",
      "predesktop:dist": "npm run prepare:desktop-runtime",
      "predesktop:dist:preview": "npm run prepare:desktop-runtime",
      "desktop:pack": "node desktop/packaging/build-development.mjs",
      "desktop:dist": "node desktop/release/build-release.mjs stable",
      "desktop:dist:preview": "node desktop/release/build-release.mjs preview",
    });
    expect(vitestConfiguration).toContain('"**/.relayer/**"');
    expect(packaging).toContain('"macos/entitlements.mac.plist"');
    expect(packaging).toContain('"!packaging/**/*"');
    expect(packaging).toContain('resolve(cargoTargetRoot, `${serverTarget}/release/relayer-app-server');
    expect(packaging).toContain('afterPack: "desktop/packaging/verify-bundled-app-server.mjs"');
    expect(packaging).toContain('win: {\n      icon: resolve(desktopRoot, "renderer/assets/relayer-logo.svg")');
    expect(desktopPreload).toContain("platform: process.platform");
    expect(rendererMain).toContain('desktop?.platform === "win32"');
    expect(packaging).toContain('"packages/graph-client/dist"');
    expect(desktopMain).toContain('"graph-client", "index.js"');
    expect(desktopMain).toContain("codexBasicClientModuleUrl: graphClientModuleUrl");
    expect(desktopMain).not.toContain("bundledCodexBinary");
    expect(desktopMain).toContain("createManagedRuntimeInstaller");
    expect(packaging).toContain('to: "renderer"');
    expect(packaging).toContain('ladybugNoticesExtraResource(repositoryRoot)');
    expect(threads).not.toContain("/messages");
    expect(threads).not.toContain("EventSource");
    expect(threads).toContain("permissionProfileId");
    expect(threads).toMatch(/function loadThread[\s\S]*setMainView\("thread"\);[\s\S]*refreshState\(threadId\)/);
    expect(rendererMain).not.toContain("/messages");
    expect(rendererMain).not.toContain("/interrupt");
    expect(prd).toContain('src="assets/product-walkthrough.html"');
    expect(prd).toContain("Historical app-server foundation checkpoint");
    expect(prd).toContain("No capability has complete end-to-end product proof. Nine capabilities are partial, and one is open.");
    expect(prdTracker).not.toContain('class="requirement-row status-verified"');
    expect(prdTracker.match(/class="requirement-row status-partial"/g)).toHaveLength(9);
    expect(prdTracker.match(/class="requirement-row status-open"/g)).toHaveLength(1);
    expect(prd).toContain("APP-001-E1");
    expect(prd).toContain("APP-001-E2");
    expect(prd).toContain("APP-001-E3");
    expect(prd).toContain('assets/evidence/app-server/thread-created.png');
    expect(prd).toContain('assets/evidence/app-server/thread-reopened.png');
    expect(prd).toContain('assets/evidence/app-server/packaged-startup.png');
    expect(prd).toContain('document: \'docs/prd/index.html\'');
    expect(prdServer).toContain('join(prdDirectory, "comments.json")');
    expect(packageManifest).not.toContain('"marked"');
  });

  it("selects only available product permission profiles and discloses full access", () => {
    const profiles = [
      { id: "ask", label: "Ask for approval", available: true },
      { id: "auto", label: "Approve for me", available: true },
      { id: "full", label: "Full access", available: true },
    ];
    expect(resolvePermissionSelection({ defaultProfile: "auto", profiles })).toBe("auto");
    expect(resolvePermissionSelection({ defaultProfile: "auto", profiles }, "ask")).toBe("ask");
    expect(resolvePermissionSelection({
      defaultProfile: "auto",
      profiles: profiles.map((profile) => ({ ...profile, available: profile.id === "ask" })),
    }, "full")).toBe("ask");
    expect(() => resolvePermissionSelection({
      defaultProfile: "auto",
      profiles: profiles.map((profile) => ({ ...profile, available: false })),
    })).toThrow("No permission profile is available");
    expect(permissionPickerDisabled(profiles.map((profile) => ({ ...profile, available: false })))).toBe(false);
    expect(permissionPickerDisabled([])).toBe(true);
    expect(permissionProfileDescription(profiles[2])).toContain("not hard-confined");
  });

  it("keeps release targets and signature verification free of bundled harness runtimes", () => {
    for (const target of [
      desktopTarget({ platform: "darwin", architecture: "arm64" }),
      desktopTarget({ platform: "darwin", architecture: "x64" }),
      desktopTarget({ platform: "win32", architecture: "x64" }),
    ]) {
      expect(target).not.toHaveProperty("codexPackage");
      expect(target).not.toHaveProperty("codexVendor");
    }
    const windowsExecutables = windowsApplicationExecutables("C:/Relayer");
    expect(windowsExecutables).toHaveLength(3);
    expect(windowsExecutables).toEqual(expect.arrayContaining([
      expect.stringMatching(/Relayer\.exe$/),
      expect.stringMatching(/relayer-app-server\.exe$/),
      expect.stringMatching(/relayer-graph-server\.exe$/),
    ]));
    expect(windowsExecutables.join("\n")).not.toMatch(/codex|claude/i);
  });

  it("requires the exact timestamped Windows certificate subject", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-windows-signature-"));
    const paths = [join(directory, "Relayer.exe"), join(directory, "relayer-app-server.exe")];
    try {
      await Promise.all(paths.map((path) => writeFile(path, "signed-executable-fixture")));
      const result = (subject) => paths.map((path) => ({
        Path: path,
        Status: "Valid",
        StatusMessage: "Signature verified.",
        Subject: subject,
        Thumbprint: "A".repeat(40),
        TimestampSubject: "CN=Microsoft Public RSA Timestamping CA 2020",
      }));
      await expect(verifyWindowsSignatures({
        paths,
        publisherName: WINDOWS_PUBLISHER_DN,
        execute: async (command) => {
          expect(command).toBe("powershell.exe");
          return { stdout: JSON.stringify(result(WINDOWS_PUBLISHER_DN)), stderr: "" };
        },
      })).resolves.toHaveLength(2);
      await expect(verifyWindowsSignatures({
        paths,
        publisherName: WINDOWS_PUBLISHER_DN,
        execute: async () => ({
          stdout: JSON.stringify(result(`${WINDOWS_PUBLISHER_DN}, OU=Unsealed`)),
          stderr: "",
        }),
      })).rejects.toThrow("Authenticode verification failed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the Eval shell separate while reusing the production product workspace", async () => {
    const productPackaging = await readFile(new URL("../desktop/packaging/electron-builder.mjs", import.meta.url), "utf8");
    const evalPackaging = await readFile(new URL("../desktop/packaging/eval-electron-builder.mjs", import.meta.url), "utf8");
    const evalMain = await readFile(new URL("../desktop/eval-main/index.mjs", import.meta.url), "utf8");
    const evalDashboard = await readFile(new URL("../desktop/eval-renderer/index.html", import.meta.url), "utf8");
    const evalDashboardMain = await readFile(new URL("../desktop/eval-renderer/main.js", import.meta.url), "utf8");
    const evalPreload = await readFile(new URL("../desktop/preload/eval-dashboard.cjs", import.meta.url), "utf8");
    const graphAdapter = await readFile(new URL("../desktop/renderer/src/graph.js", import.meta.url), "utf8");
    const modelPicker = await readFile(new URL("../desktop/renderer/src/model-picker.js", import.meta.url), "utf8");
    const productWorkspace = await readFile(new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url), "utf8");
    const navigation = await readFile(new URL("../desktop/renderer/src/navigation.js", import.meta.url), "utf8");

    expect(productPackaging).toContain('"!eval-main/**/*"');
    expect(productPackaging).toContain('"!eval-renderer/**/*"');
    expect(productPackaging).toContain('"!preload/eval-*.cjs"');
    expect(evalPackaging).toContain('appId: "ai.relayer.eval"');
    expect(evalPackaging).toContain('main: "eval-main/index.mjs"');
    expect(evalPackaging).toContain('target: [{ target: "dir", arch: [target.architecture] }]');
    expect(evalPackaging).toContain('"main/single-instance.mjs"');
    expect(evalPackaging).toContain('{ from: resolve(desktopRoot, "renderer"), to: "renderer" }');
    expect(evalPackaging).toContain('ladybugNoticesExtraResource(repositoryRoot)');
    expect(evalPackaging).toContain('"packages/graph-client/dist"');
    expect(evalMain).toContain("GraphCompleteRuntimeService");
    expect(evalMain).toContain("RelayerAppServerService");
    expect(evalMain).toContain("allowHarnessOverride: true");
    expect(evalMain).toContain("enableReadOnlySession: true");
    expect(evalMain).toContain("productSession.readOnlyCookie");
    expect(evalMain).toContain("claimPrimaryDesktopInstance");
    expect(evalMain).toContain("createReviewWindow(executionId)");
    expect(evalMain).toContain("evalRuntimeTarget({ isPackaged: app.isPackaged, environment: process.env })");
    expect(evalMain).toContain("targetKey: evalTarget.key");
    expect(evalMain).toContain("process.env.PYTHONPATH");
    expect(evalDashboard).toContain("Test cases");
    expect(evalDashboard).toContain("Harnesses under test");
    expect(evalDashboard).toContain("Ablation presets");
    expect(evalDashboard).toContain("Open the judge review or the read-only production workspace");
    expect(evalDashboard).not.toContain('id="judgeOutputPanel"');
    expect(evalDashboardMain).toContain("Judge review ↗");
    expect(evalDashboardMain).toContain("Product workspace ↗");
    expect(evalDashboardMain).toContain("bindAblationControls");
    expect(evalDashboardMain).toContain("selectionFromControls");
    expect(evalDashboardMain).toContain("createRunFromControls");
    expect(evalDashboardMain).not.toContain("renderJudgeOutput");
    expect(evalPreload).toContain("openJudgeReview");
    expect(evalPreload).toContain("loadJudgeScreenshot");
    expect(evalPreload).not.toContain("conversation-export");
    expect(evalMain).toContain('join(evalRendererDirectory, "judge.html")');
    expect(productWorkspaceMode({ thread: { imported: true } })).toBe("review");
    expect(graphAdapter).toContain("mode: nextMode");
    expect(graphAdapter).toContain("productWorkspace.dispose()");
    expect(modelPicker).toContain('removeEventListener("click", outsideClick)');
    expect(productWorkspace).toContain("modelPicker?.dispose()");
    expect(navigation).toContain("viewState.evalContext.cases");
    expect(workspaceModeCapabilities("review")).toEqual({
      canCompose: false,
      canNavigate: true,
      canInvokeMutatingActions: false,
      canExportConversation: false,
      canResolveApprovals: false,
    });
  });

  it("rebuilds workspace authority when server-authored imported state changes", () => {
    expect(productWorkspaceMode({ thread: { imported: false } })).toBe("interactive");
    expect(productWorkspaceMode({ thread: { imported: true } })).toBe("review");
    expect(productWorkspaceNeedsRecreation("interactive", "review")).toBe(true);
    expect(productWorkspaceNeedsRecreation("review", "interactive")).toBe(true);
    expect(productWorkspaceNeedsRecreation("review", "review")).toBe(false);
  });

  it("coalesces repeated first-thread submissions while creation is pending", async () => {
    const globalNames = ["document", "fetch", "history", "location", "localStorage", "window"];
    const originalGlobals = new Map(
      globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
    );
    const input = { value: "Build the first thread", disabled: false };
    const button = { disabled: false };
    const permissionButton = { disabled: false, setAttribute: vi.fn() };
    const permissionMenu = { classList: { add: vi.fn() } };
    const toastElement = {
      textContent: "",
      classList: { add: vi.fn(), remove: vi.fn() },
    };
    let rejectRequest;
    const fetch = vi.fn(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
    const elements = new Map([
      ["#newThreadPrompt", input],
      ["#createThread", button],
      ["#permissionButton", permissionButton],
      ["#permissionMenu", permissionMenu],
      ["#toast", toastElement],
    ]);
    Object.assign(globalThis, {
      document: { querySelector: (selector) => elements.get(selector) },
      fetch,
      history: { replaceState: vi.fn() },
      location: new URL("http://127.0.0.1:43123/"),
      localStorage: { setItem: vi.fn() },
      window: { GRAPHCOMPLETE_CONFIG: null, relayerDesktop: undefined },
    });
    vi.useFakeTimers();
    const cancelPendingAutomatic = vi.fn();
    vi.doMock("../desktop/renderer/src/onboarding-tutorial.js", () => ({
      onboardingTutorialController: () => ({
        cancelPendingAutomatic,
        threadCreated: vi.fn(),
      }),
    }));
    try {
      const { viewState } = await import("../desktop/renderer/src/state.js");
      viewState.selectedPermissionProfileId = "auto";
      const { createFirstThread } = await import("../desktop/renderer/src/threads.js?submission-guard");
      const pickerPayload = {
        harnessId: "codex-basic",
        modelSelection: { familyId: 1, providerId: "codex", modelId: "gpt-5" },
      };
      const first = createFirstThread(pickerPayload);
      const repeated = createFirstThread(pickerPayload);
      expect(cancelPendingAutomatic).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledOnce();
      expect(cancelPendingAutomatic.mock.invocationCallOrder[0])
        .toBeLessThan(fetch.mock.invocationCallOrder[0]);
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
        permissionProfileId: "auto",
        ...pickerPayload,
      });
      expect(input.disabled).toBe(true);
      expect(button.disabled).toBe(true);

      rejectRequest(new Error("test request stopped"));
      await Promise.all([first, repeated]);
      expect(fetch).toHaveBeenCalledOnce();
      expect(input.disabled).toBe(false);
      expect(button.disabled).toBe(true);
      expect(toastElement.textContent).toBe("test request stopped");
    } finally {
      vi.doUnmock("../desktop/renderer/src/onboarding-tutorial.js");
      vi.clearAllTimers();
      vi.useRealTimers();
      for (const [name, descriptor] of originalGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  });

  it("lets a later project composer supersede an in-flight first-thread Send", async () => {
    const globalNames = ["document", "fetch", "history", "location", "localStorage", "window"];
    const originalGlobals = new Map(
      globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
    );
    const input = { value: "Keep the newer project draft", disabled: false };
    const button = { disabled: false };
    const permissionButton = { disabled: false, setAttribute: vi.fn() };
    const permissionMenu = { classList: { add: vi.fn() } };
    const toastElement = { textContent: "", classList: { add: vi.fn(), remove: vi.fn() } };
    let resolveRequest;
    const fetch = vi.fn(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const localStorage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const elements = new Map([
      ["#newThreadPrompt", input],
      ["#createThread", button],
      ["#permissionButton", permissionButton],
      ["#permissionMenu", permissionMenu],
      ["#toast", toastElement],
    ]);
    Object.assign(globalThis, {
      document: { querySelector: (selector) => elements.get(selector) },
      fetch,
      history: { replaceState: vi.fn() },
      location: new URL("http://127.0.0.1:43123/"),
      localStorage,
      window: { GRAPHCOMPLETE_CONFIG: null, relayerDesktop: undefined, localStorage },
    });
    vi.useFakeTimers();
    vi.doMock("../desktop/renderer/src/onboarding-tutorial.js", () => ({
      onboardingTutorialController: () => ({ cancelPendingAutomatic: vi.fn(), threadCreated: vi.fn() }),
    }));
    try {
      const { viewState } = await import("../desktop/renderer/src/state.js");
      viewState.currentThreadId = null;
      viewState.selectedPermissionProfileId = "auto";
      viewState.selectedScope = { kind: "project", projectId: 1, label: "First" };
      const { projectComposerGate } = await import("../desktop/renderer/src/project-composer-navigation.js");
      const { createFirstThread } = await import("../desktop/renderer/src/threads.js?submission-superseded");
      const pending = createFirstThread({
        harnessId: "codex-basic",
        modelSelection: { familyId: 1, providerId: "codex", modelId: "gpt-5" },
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

      projectComposerGate.begin();
      viewState.selectedScope = { kind: "project", projectId: 2, label: "Second" };
      resolveRequest(new Response(JSON.stringify({ id: 42, rootInteractionId: 84 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
      await pending;

      expect(viewState.currentThreadId).toBeNull();
      expect(input.value).toBe("Keep the newer project draft");
      expect(localStorage.setItem).not.toHaveBeenCalled();
      expect(toastElement.textContent).toBe("");
    } finally {
      vi.doUnmock("../desktop/renderer/src/onboarding-tutorial.js");
      vi.clearAllTimers();
      vi.useRealTimers();
      for (const [name, descriptor] of originalGlobals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  });

  it("starts and stops the Rust product server with an isolated profile and private session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-app-server-service-"));
    const invocations = [];
    let suppliedToken = "";
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(chunk, _encoding, callback) { suppliedToken += String(chunk); callback(); } }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      killed: false,
    });
    child.kill = vi.fn((signal) => {
      child.killed = true;
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    });
    const service = new RelayerAppServerService({
      userDataDirectory: directory,
      binaryPath: "/test/bin/relayer-app-server",
      webDirectory: "/test/renderer",
      permissionCatalogPath: "/test/permissions/desktop.json",
      enableReadOnlySession: true,
      spawnProcess: (binary, args, options) => {
        invocations.push({ binary, args, options });
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({
          ready: true,
          origin: "http://127.0.0.1:43123",
          cookieName: "relayer_control",
        })}\n`));
        return child;
      },
    });

    try {
      const firstStart = service.start();
      const duplicateStart = service.start();
      const [session, duplicateSession] = await Promise.all([firstStart, duplicateStart]);
      expect(duplicateSession).toBe(session);
      expect(session).toMatchObject({
        origin: "http://127.0.0.1:43123",
        cookie: { name: "relayer_control" },
      });
      expect(session.cookie.value).toMatch(/^[a-f0-9]{64}$/);
      expect(session.readOnlyCookie).toMatchObject({ name: "relayer_control" });
      expect(session.readOnlyCookie.value).toMatch(/^[a-f0-9]{64}$/);
      expect(session.readOnlyCookie.value).not.toBe(session.cookie.value);
      expect(invocations).toHaveLength(1);
      expect(invocations[0].binary).toBe("/test/bin/relayer-app-server");
      expect(invocations[0].args).toEqual([
        "--data-dir", join(directory, "product-data"),
        "--web-dir", "/test/renderer",
        "--permission-catalog", "/test/permissions/desktop.json",
        "--port", "0",
        "--producer-desktop-version", "development",
        "--producer-build-commit", "development",
        "--producer-platform", process.platform,
        "--producer-architecture", process.arch,
        "--read-only-control-token-stdin",
        "--authenticated-error-capability-stdin",
      ]);
      expect(suppliedToken).toBe(
        `${session.cookie.value}\n${session.readOnlyCookie.value}\n`
        + '{"schema":"relayer.authenticated-error-capability/v1","capability":null}\n',
      );
      expect(child.stdin.writableEnded).toBe(false);
      expect(invocations[0].args).not.toContain(session.cookie.value);
      expect(invocations[0].args).not.toContain(session.readOnlyCookie.value);
      expect((await stat(join(directory, "product-data"))).mode & 0o777).toBe(0o700);
      expect(await service.start()).toBe(session);
      const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(null, { status: 204 }));
      await service.publishProviderCatalog({ providerId: "codex", models: [] });
      expect(fetch).toHaveBeenCalledWith(
        new URL("http://127.0.0.1:43123/api/internal/provider-catalog"),
        expect.objectContaining({
          method: "PUT",
          headers: {
            Authorization: `Bearer ${session.cookie.value}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ providerId: "codex", models: [] }),
        }),
      );
      expect(fetch.mock.calls[0][1].headers).not.toHaveProperty("Cookie");
      fetch.mockRestore();
      const exportBytes = new TextEncoder().encode('{"recordType":"header"}\n');
      const exportFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(exportBytes, {
        headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
      }));
      expect(await service.exportConversation(7)).toEqual(exportBytes);
      expect(exportFetch).toHaveBeenCalledWith(
        new URL("http://127.0.0.1:43123/api/threads/7/export"),
        expect.objectContaining({
          headers: { Cookie: `relayer_control=${session.cookie.value}` },
        }),
      );
      exportFetch.mockRestore();
      await service.close();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      const neverSpawned = vi.fn();
      const closedWhilePreparing = new RelayerAppServerService({
        userDataDirectory: join(directory, "closed-while-preparing"),
        binaryPath: "/test/bin/should-not-start",
        webDirectory: "/test/renderer",
        permissionCatalogPath: "/test/permissions/desktop.json",
        spawnProcess: neverSpawned,
      });
      const pendingStart = closedWhilePreparing.start();
      await closedWhilePreparing.close();
      await expect(pendingStart).rejects.toThrow("shutting down");
      expect(neverSpawned).not.toHaveBeenCalled();

      const failedChild = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: vi.fn(function kill(signal) {
          this.killed = true;
          this.signalCode = signal;
          queueMicrotask(() => this.emit("exit", null, signal));
          return true;
        }),
      });
      const unavailable = new RelayerAppServerService({
        userDataDirectory: directory,
        binaryPath: "/missing/relayer-app-server",
        webDirectory: "/test/renderer",
        permissionCatalogPath: "/test/permissions/desktop.json",
        spawnProcess: () => {
          queueMicrotask(() => failedChild.emit("error", new Error("spawn ENOENT")));
          return failedChild;
        },
      });
      await expect(unavailable.start()).rejects.toThrow("could not start: spawn ENOENT");
      expect(failedChild.kill).toHaveBeenCalledWith("SIGTERM");

      const rejectedHandshakeChild = Object.assign(new EventEmitter(), {
        stdin: {
          on: vi.fn(),
          write: vi.fn(() => { throw new Error("control pipe closed"); }),
        },
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: vi.fn(function kill(signal) {
          this.killed = true;
          this.signalCode = signal;
          queueMicrotask(() => this.emit("exit", null, signal));
          return true;
        }),
      });
      const rejectedHandshake = new RelayerAppServerService({
        userDataDirectory: directory,
        binaryPath: "/test/bin/rejected-handshake",
        webDirectory: "/test/renderer",
        permissionCatalogPath: "/test/permissions/desktop.json",
        spawnProcess: () => rejectedHandshakeChild,
      });
      await expect(rejectedHandshake.start()).rejects.toThrow("control pipe closed");
      expect(rejectedHandshakeChild.kill).toHaveBeenCalledWith("SIGTERM");

      const remoteChild = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: vi.fn(function kill(signal) {
          this.killed = true;
          this.signalCode = signal;
          queueMicrotask(() => this.emit("exit", null, signal));
          return true;
        }),
      });
      const untrusted = new RelayerAppServerService({
        userDataDirectory: directory,
        binaryPath: "/test/bin/untrusted-server",
        webDirectory: "/test/renderer",
        permissionCatalogPath: "/test/permissions/desktop.json",
        spawnProcess: () => {
          queueMicrotask(() => remoteChild.stdout.write(`${JSON.stringify({
            ready: true,
            origin: "https://example.test",
            cookieName: "relayer_control",
          })}\n`));
          return remoteChild;
        },
      });
      await expect(untrusted.start()).rejects.toThrow("must use an authenticated 127.0.0.1 origin");
      expect(remoteChild.kill).toHaveBeenCalledWith("SIGTERM");

      const stubbornChild = Object.assign(new EventEmitter(), {
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
      });
      stubbornChild.kill = vi.fn((signal) => {
        if (signal === "SIGKILL") {
          stubbornChild.signalCode = signal;
          queueMicrotask(() => stubbornChild.emit("exit", null, signal));
        }
        return true;
      });
      const timedOut = new RelayerAppServerService({
        userDataDirectory: directory,
        binaryPath: "/test/bin/stubborn-server",
        webDirectory: "/test/renderer",
        permissionCatalogPath: "/test/permissions/desktop.json",
        startupTimeoutMs: 5,
        shutdownTimeoutMs: 5,
        spawnProcess: () => stubbornChild,
      });
      await expect(timedOut.start()).rejects.toThrow("did not become ready in time");
      expect(stubbornChild.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);

      const unexpectedStops = [];
      const crashingChild = Object.assign(new EventEmitter(), {
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: vi.fn(),
      });
      const crashing = new RelayerAppServerService({
        userDataDirectory: directory,
        binaryPath: "/test/bin/crashing-server",
        webDirectory: "/test/renderer",
        permissionCatalogPath: "/test/permissions/desktop.json",
        onUnexpectedStop: (event) => unexpectedStops.push(event),
        spawnProcess: () => {
          queueMicrotask(() => crashingChild.stdout.write(`${JSON.stringify({
            ready: true,
            origin: "http://127.0.0.1:43124",
            cookieName: "relayer_control",
          })}\n`));
          return crashingChild;
        },
      });
      await crashing.start();
      crashingChild.exitCode = 2;
      crashingChild.emit("exit", 2, null);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unexpectedStops).toEqual([{ code: 2, signal: null }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps graph authority off argv and reports a graph server that stops after readiness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-runtime-service-"));
    const configurationPath = fileURLToPath(new URL("../harnesses/codex-basic.yaml", import.meta.url));
    const persistedConfiguration = parseYaml(await readFile(configurationPath, "utf8"));
    await mkdir(join(directory, "graphcomplete-runtime"), { recursive: true });
    await writeFile(join(directory, "graphcomplete-runtime", "harness-configurations.json"), JSON.stringify({
      schemaVersion: 1,
      configurations: [{
        configuration: persistedConfiguration,
        digest: digestHarnessConfiguration(persistedConfiguration),
        runtimeAvailable: true,
        unavailableReason: null,
        readinessGeneration: 4,
      }],
      unavailableConfigurations: [],
    }));
    const validateHarnessRuntime = vi.fn(async () => true);
    let suppliedToken = "";
    const unexpectedStops = [];
    const invocations = [];
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(chunk, _encoding, callback) { suppliedToken += String(chunk); callback(); } }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    });
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [configurationPath],
      unavailableConfigurations: [{
        name: "prime-agent-basic",
        reason: {
          code: "prime_agent_boundary_unsupported",
          message: "Prime Agent Ask and Auto require macOS. Choose another available harness on this device.",
        },
        diagnostics: {
          sourceCommit: "f6130839ad3043f1cd3d5294fe03023035bfcd5c",
          packages: [{ name: "@earendil-works/pi-coding-agent", version: "0.8.1" }],
        },
      }],
      coordinateHarnessReadiness: true,
      validateHarnessRuntime,
      onUnexpectedStop: (event) => unexpectedStops.push(event),
      spawnProcess: (binary, args, options) => {
        invocations.push({ binary, args, options });
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ ready: true, url: "http://127.0.0.1:43125" })}\n`));
        return child;
      },
    });

    try {
      const [session, concurrentSession] = await Promise.all([service.start(), service.start()]);
      expect(concurrentSession).toBe(session);
      expect(invocations).toHaveLength(1);
      expect(session.graphControlToken).toMatch(/^[a-f0-9]{64}$/);
      expect(session.harnessControlToken).toMatch(/^[a-f0-9]{64}$/);
      expect(session.harnessControlToken).not.toBe(session.graphControlToken);
      expect(session.graphUrl).toBe("http://127.0.0.1:43125");
      expect(service.graphOperationRecorder).toBeNull();
      expect(session.configurationNames).toEqual(["codex-basic"]);
      const catalog = JSON.parse(await readFile(session.catalogPath, "utf8"));
      expect(catalog.configurations).toEqual([
        expect.objectContaining({
          runtimeAvailable: true,
          unavailableReason: null,
          readinessGeneration: 0,
        }),
      ]);
      expect(catalog.unavailableConfigurations).toEqual([expect.objectContaining({
        name: "prime-agent-basic",
        reason: expect.objectContaining({ code: "prime_agent_boundary_unsupported" }),
        diagnostics: expect.objectContaining({ sourceCommit: "f6130839ad3043f1cd3d5294fe03023035bfcd5c" }),
      })]);
      expect(validateHarnessRuntime).toHaveBeenCalledOnce();
      await service.recordHarnessReadiness([{
        harnessId: "codex-basic",
        configurationDigest: digestHarnessConfiguration(persistedConfiguration),
        generation: 5,
        available: false,
        unavailableReason: { code: "runtime_corrupt", message: "This execution configuration is currently unavailable." },
      }]);
      await service.recordHarnessReadiness([{
        harnessId: "codex-basic",
        configurationDigest: digestHarnessConfiguration(persistedConfiguration),
        generation: 4,
        available: true,
        unavailableReason: null,
      }]);
      const recordedCatalog = JSON.parse(await readFile(session.catalogPath, "utf8"));
      expect(recordedCatalog.configurations[0]).toMatchObject({
        runtimeAvailable: false,
        readinessGeneration: 5,
        unavailableReason: { code: "runtime_corrupt" },
      });
      expect(suppliedToken).toBe(
        `${session.graphControlToken}\n`
        + '{"schema":"relayer.authenticated-error-capability/v1","capability":null}\n',
      );
      expect(invocations[0].args).toContain("--authenticated-error-capability-stdin");
      expect(invocations[0].args).not.toContain("--control-token");
      expect(invocations[0].args).not.toContain(session.graphControlToken);
      expect(invocations[0].args).not.toContain(session.harnessControlToken);
      expect(invocations[0].options.stdio).toEqual(["pipe", "pipe", "pipe"]);
      expect((await fetch(`${session.harnessUrl}/health`, {
        headers: { authorization: `Bearer ${session.graphControlToken}` },
      })).status).toBe(401);
      expect((await fetch(`${session.harnessUrl}/health`, {
        headers: { authorization: `Bearer ${session.harnessControlToken}` },
      })).status).toBe(200);

      child.exitCode = 9;
      child.emit("exit", 9, null);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unexpectedStops).toEqual([{ code: 9, signal: null }]);
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hides and reports persisted readiness when restart-local descriptor validation detects corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-runtime-corrupt-readiness-"));
    const configurationPath = fileURLToPath(new URL("../harnesses/codex-basic.yaml", import.meta.url));
    const configuration = parseYaml(await readFile(configurationPath, "utf8"));
    const runtimeDirectory = join(directory, "graphcomplete-runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(join(runtimeDirectory, "harness-configurations.json"), JSON.stringify({
      schemaVersion: 1,
      configurations: [{
        configuration,
        digest: digestHarnessConfiguration(configuration),
        runtimeAvailable: true,
        unavailableReason: null,
        readinessGeneration: 8,
      }],
      unavailableConfigurations: [],
    }));
    const corruption = new Error("managed executable is missing");
    const onHarnessRuntimeValidationFailure = vi.fn(async () => {});
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
      kill: vi.fn(function kill() { this.exitCode = 0; this.emit("exit", 0, null); }),
    });
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [configurationPath],
      coordinateHarnessReadiness: true,
      validateHarnessRuntime: vi.fn(async () => { throw corruption; }),
      onHarnessRuntimeValidationFailure,
      spawnProcess: () => {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ ready: true, url: "http://127.0.0.1:43126" })}\n`));
        return child;
      },
    });
    try {
      const session = await service.start();
      const catalog = JSON.parse(await readFile(session.catalogPath, "utf8"));
      expect(catalog.configurations[0]).toMatchObject({
        runtimeAvailable: false,
        unavailableReason: { code: "harness_readiness_pending" },
      });
      expect(onHarnessRuntimeValidationFailure).toHaveBeenCalledWith(
        expect.objectContaining({ name: "codex-basic" }), corruption,
      );
    } finally {
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resets persisted readiness ordering for a new coordinator epoch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-runtime-readiness-epoch-"));
    const configurationPath = fileURLToPath(new URL("../harnesses/codex-basic.yaml", import.meta.url));
    const configuration = parseYaml(await readFile(configurationPath, "utf8"));
    const digest = digestHarnessConfiguration(configuration);
    const runtimeDirectory = join(directory, "graphcomplete-runtime");
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(join(runtimeDirectory, "harness-configurations.json"), JSON.stringify({
      schemaVersion: 1,
      configurations: [{
        configuration,
        digest,
        runtimeAvailable: true,
        unavailableReason: null,
        readinessGeneration: 8,
      }],
      unavailableConfigurations: [],
    }));
    const services = [];
    const createService = (validateHarnessRuntime) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
        stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
        kill: vi.fn(function kill() { this.exitCode = 0; this.emit("exit", 0, null); }),
      });
      const service = new GraphCompleteRuntimeService({
        userDataDirectory: directory,
        graphServerBinary: "/test/bin/relayer-graph-server",
        configurationPaths: [configurationPath],
        coordinateHarnessReadiness: true,
        validateHarnessRuntime,
        spawnProcess: () => {
          queueMicrotask(() => child.stdout.write(`${JSON.stringify({ ready: true, url: "http://127.0.0.1:43127" })}\n`));
          return child;
        },
      });
      services.push(service);
      return service;
    };
    try {
      const firstValidation = vi.fn(async () => true);
      const first = createService(firstValidation);
      const firstSession = await first.start();
      expect(JSON.parse(await readFile(firstSession.catalogPath, "utf8")).configurations[0]).toMatchObject({
        runtimeAvailable: true,
        readinessGeneration: 0,
      });

      await first.recordHarnessReadiness([{
        harnessId: "codex-basic",
        configurationDigest: digest,
        generation: 1,
        available: false,
        unavailableReason: { code: "runtime_corrupt", message: "This execution configuration is currently unavailable." },
      }]);
      expect(JSON.parse(await readFile(firstSession.catalogPath, "utf8")).configurations[0]).toMatchObject({
        runtimeAvailable: false,
        readinessGeneration: 1,
        unavailableReason: { code: "runtime_corrupt" },
      });
      await first.close();

      const secondValidation = vi.fn(async () => true);
      const secondSession = await createService(secondValidation).start();
      expect(JSON.parse(await readFile(secondSession.catalogPath, "utf8")).configurations[0]).toMatchObject({
        runtimeAvailable: false,
        unavailableReason: { code: "harness_readiness_pending" },
      });
      expect(secondValidation).not.toHaveBeenCalled();
    } finally {
      await Promise.allSettled(services.map((service) => service.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not spawn the graph server when close interrupts harness-module loading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-runtime-import-close-"));
    const spawnProcess = vi.fn();
    const hookName = `__relayerRuntimeImportClose${Date.now()}${Math.random().toString(16).slice(2)}`;
    let resolveImportEntered;
    let resolveImport;
    const importEntered = new Promise((resolve) => { resolveImportEntered = resolve; });
    const importPending = new Promise((resolve) => { resolveImport = resolve; });
    globalThis[hookName] = { importEntered: resolveImportEntered, importPending };
    const delayedHarnessModule = `data:text/javascript,${encodeURIComponent(`
      globalThis[${JSON.stringify(hookName)}].importEntered();
      await globalThis[${JSON.stringify(hookName)}].importPending;
      export const digestHarnessConfiguration = () => "digest";
      export const createCodexBasicFactory = () => ({});
      export const loadHarnessConfigurations = async () => new Map();
      export const productHarnessImplementations = () => ({});
      export const startHarnessHost = async () => { throw new Error("must not start"); };
    `)}`;
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: delayedHarnessModule,
      spawnProcess,
    });

    try {
      const starting = service.start();
      const startingOutcome = starting.catch((error) => error);
      await importEntered;
      const closing = service.close();
      let closeTimeout;
      const closeOutcome = await Promise.race([
        closing.then(() => "closed"),
        new Promise((resolve) => {
          closeTimeout = setTimeout(() => resolve("timed out"), 250);
        }),
      ]);
      clearTimeout(closeTimeout);
      expect(closeOutcome).toBe("closed");
      expect((await startingOutcome).message).toBe("GraphComplete runtime is shutting down.");
      expect(spawnProcess).not.toHaveBeenCalled();

      // A dynamic import cannot itself be cancelled. Its eventual settlement must
      // not resume startup after close has already completed.
      resolveImport();
      await new Promise((resolve) => setImmediate(resolve));
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(service.graphProcess).toBeNull();
      expect(service.harnessHost).toBeNull();
      expect(service.session).toBeNull();
    } finally {
      resolveImport?.();
      delete globalThis[hookName];
      await service.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not wait for a pending harness-configuration load during close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-runtime-config-close-"));
    const spawnProcess = vi.fn();
    const hookName = `__relayerRuntimeConfigClose${Date.now()}${Math.random().toString(16).slice(2)}`;
    let resolveConfigEntered;
    let resolveConfigurations;
    const configEntered = new Promise((resolve) => { resolveConfigEntered = resolve; });
    const configurationsPending = new Promise((resolve) => { resolveConfigurations = resolve; });
    globalThis[hookName] = {
      loadHarnessConfigurations: () => {
        resolveConfigEntered();
        return configurationsPending;
      },
    };
    const harnessModule = `data:text/javascript,${encodeURIComponent(`
      export const digestHarnessConfiguration = () => "digest";
      export const createCodexBasicFactory = () => ({});
      export const loadHarnessConfigurations = (...args) => globalThis[${JSON.stringify(hookName)}].loadHarnessConfigurations(...args);
      export const productHarnessImplementations = () => ({});
      export const startHarnessHost = async () => { throw new Error("must not start"); };
    `)}`;
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: harnessModule,
      spawnProcess,
    });

    try {
      const starting = service.start();
      const startingOutcome = starting.catch((error) => error);
      await configEntered;
      const closing = service.close();
      let closeTimeout;
      const closeOutcome = await Promise.race([
        closing.then(() => "closed"),
        new Promise((resolve) => {
          closeTimeout = setTimeout(() => resolve("timed out"), 250);
        }),
      ]);
      clearTimeout(closeTimeout);
      expect(closeOutcome).toBe("closed");
      expect((await startingOutcome).message).toBe("GraphComplete runtime is shutting down.");
      expect(spawnProcess).not.toHaveBeenCalled();

      resolveConfigurations(new Map());
      await new Promise((resolve) => setImmediate(resolve));
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      resolveConfigurations?.(new Map());
      delete globalThis[hookName];
      await service.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes a harness host that finishes starting after runtime closure begins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-runtime-harness-close-"));
    const hookName = `__relayerRuntimeStartClose${Date.now()}${Math.random().toString(16).slice(2)}`;
    let resolveHarnessStart;
    let resolveHarnessHost;
    const harnessStartEntered = new Promise((resolve) => { resolveHarnessStart = resolve; });
    const harnessHostPending = new Promise((resolve) => { resolveHarnessHost = resolve; });
    globalThis[hookName] = {
      startHarnessHost: () => {
        resolveHarnessStart();
        return harnessHostPending;
      },
    };
    const harnessModule = `data:text/javascript,${encodeURIComponent(`
      export const digestHarnessConfiguration = () => "digest";
      export const createCodexBasicFactory = () => ({});
      export const loadHarnessConfigurations = async () => new Map();
      export const productHarnessImplementations = () => ({});
      export const startHarnessHost = (...args) => globalThis[${JSON.stringify(hookName)}].startHarnessHost(...args);
    `)}`;
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(function kill(signal) {
        if (signal === "SIGKILL") {
          this.signalCode = signal;
          this.emit("exit", null, signal);
          this.emit("close", null, signal);
        }
        return true;
      }),
    });
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: harnessModule,
      spawnProcess: () => {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ ready: true, url: "http://127.0.0.1:43126" })}\n`));
        return child;
      },
      shutdownTimeoutMs: 10,
    });
    const lateCleanupError = new Error("late cleanup failed after shutdown deadline");
    const lifecycle = [];
    let listenerOpen = true;
    const closeHarnessHost = vi.fn(async () => {
      lifecycle.push("graceful");
      throw lateCleanupError;
    });
    const forceCloseHarnessHost = vi.fn(() => {
      lifecycle.push("force");
      listenerOpen = false;
    });

    try {
      const starting = service.start();
      const startingOutcome = starting.catch((error) => error);
      await harnessStartEntered;
      const closing = service.close();
      let closeTimeout;
      const closeOutcome = await Promise.race([
        closing.then(
          () => ({ status: "fulfilled" }),
          (error) => ({ status: "rejected", error }),
        ),
        new Promise((resolve) => {
          closeTimeout = setTimeout(() => resolve({ status: "timed out" }), 250);
        }),
      ]);
      clearTimeout(closeTimeout);
      expect(closeOutcome.status).toBe("rejected");
      expect(closeOutcome.error).toBeInstanceOf(AggregateError);
      expect(closeOutcome.error.errors.some((error) => error?.code === "RELAYER_RUNTIME_STARTUP_CLEANUP_TIMEOUT")).toBe(true);
      expect((await startingOutcome).message).toBe("GraphComplete runtime is shutting down.");
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(closeHarnessHost).not.toHaveBeenCalled();

      // A host that is created after close completes remains owned by this
      // service and is disposed as soon as the pending factory settles.
      resolveHarnessHost({ url: "http://127.0.0.1:43127", close: closeHarnessHost, forceClose: forceCloseHarnessHost });
      await vi.waitFor(() => expect(closeHarnessHost).toHaveBeenCalledOnce());
      await new Promise((resolve) => setImmediate(resolve));
      expect(closeHarnessHost).toHaveBeenCalledOnce();
      expect(forceCloseHarnessHost).toHaveBeenCalledOnce();
      expect(lifecycle).toEqual(["graceful", "force"]);
      expect(listenerOpen).toBe(false);
      expect(service.graphProcess).toBeNull();
      expect(service.harnessHost).toBeNull();
      expect(service.session).toBeNull();
    } finally {
      resolveHarnessHost?.({ url: "http://127.0.0.1:43127", close: closeHarnessHost, forceClose: forceCloseHarnessHost });
      delete globalThis[hookName];
      await service.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("awaits late harness cleanup within the shutdown grace and reports cleanup failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-runtime-harness-cleanup-fence-"));
    const hookName = `__relayerRuntimeCleanupFence${Date.now()}${Math.random().toString(16).slice(2)}`;
    let resolveHarnessStart;
    let resolveHarnessHost;
    let rejectHarnessClose;
    const harnessStartEntered = new Promise((resolve) => { resolveHarnessStart = resolve; });
    const harnessHostPending = new Promise((resolve) => { resolveHarnessHost = resolve; });
    const harnessClosePending = new Promise((_resolve, reject) => { rejectHarnessClose = reject; });
    globalThis[hookName] = {
      startHarnessHost: () => {
        resolveHarnessStart();
        return harnessHostPending;
      },
    };
    const harnessModule = `data:text/javascript,${encodeURIComponent(`
      export const digestHarnessConfiguration = () => "digest";
      export const createCodexBasicFactory = () => ({});
      export const loadHarnessConfigurations = async () => new Map();
      export const productHarnessImplementations = () => ({});
      export const startHarnessHost = (...args) => globalThis[${JSON.stringify(hookName)}].startHarnessHost(...args);
    `)}`;
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(function kill(signal) {
        this.signalCode = signal;
        this.emit("exit", null, signal);
        this.emit("close", null, signal);
        return true;
      }),
    });
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: harnessModule,
      spawnProcess: () => {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ ready: true, url: "http://127.0.0.1:43128" })}\n`));
        return child;
      },
      shutdownTimeoutMs: 500,
    });
    const cleanupError = new Error("late harness close failed");
    const closeHarnessHost = vi.fn(() => harnessClosePending);

    try {
      const starting = service.start();
      const startingOutcome = starting.catch((error) => error);
      await harnessStartEntered;
      const closing = service.close();
      let closeSettled = false;
      void closing.then(
        () => { closeSettled = true; },
        () => { closeSettled = true; },
      );
      resolveHarnessHost({ url: "http://127.0.0.1:43129", close: closeHarnessHost });
      await vi.waitFor(() => expect(closeHarnessHost).toHaveBeenCalledOnce());
      expect(closeSettled).toBe(false);
      rejectHarnessClose(cleanupError);
      const closeError = await closing.catch((error) => error);
      expect(closeError).toBeInstanceOf(AggregateError);
      expect(closeError.message).toBe("GraphComplete runtime did not close cleanly.");
      expect(closeError.errors).toContain(cleanupError);
      expect(closeSettled).toBe(true);
      expect((await startingOutcome).message).toBe("GraphComplete runtime is shutting down.");
      expect(closeHarnessHost).toHaveBeenCalledOnce();
      expect(service.harnessHost).toBeNull();
      expect(service.session).toBeNull();
    } finally {
      rejectHarnessClose?.(cleanupError);
      resolveHarnessHost?.({ url: "http://127.0.0.1:43129", close: closeHarnessHost });
      delete globalThis[hookName];
      await service.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not exceed the shared deadline when a late host force drain never settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-runtime-late-host-force-"));
    const hookName = `__relayerRuntimeLateHostForce${Date.now()}${Math.random().toString(16).slice(2)}`;
    let resolveHarnessStart;
    let resolveHarnessHost;
    const harnessStartEntered = new Promise((resolve) => { resolveHarnessStart = resolve; });
    const harnessHostPending = new Promise((resolve) => { resolveHarnessHost = resolve; });
    globalThis[hookName] = {
      startHarnessHost: () => {
        resolveHarnessStart();
        return harnessHostPending;
      },
    };
    const harnessModule = `data:text/javascript,${encodeURIComponent(`
      export const digestHarnessConfiguration = () => "digest";
      export const createCodexBasicFactory = () => ({});
      export const loadHarnessConfigurations = async () => new Map();
      export const productHarnessImplementations = () => ({});
      export const startHarnessHost = (...args) => globalThis[${JSON.stringify(hookName)}].startHarnessHost(...args);
    `)}`;
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(function kill(signal) {
        this.signalCode = signal;
        this.emit("exit", null, signal);
        this.emit("close", null, signal);
        return true;
      }),
    });
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: harnessModule,
      spawnProcess: () => {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ ready: true, url: "http://127.0.0.1:43132" })}\n`));
        return child;
      },
      shutdownTimeoutMs: 20,
    });
    const gracefulClosePending = new Promise(() => {});
    const closeHarnessHost = vi.fn(() => gracefulClosePending);
    const forceCloseHarnessHost = vi.fn(() => new Promise(() => {}));

    try {
      const starting = service.start();
      const startingOutcome = starting.catch((error) => error);
      await harnessStartEntered;
      const closing = service.close();
      resolveHarnessHost({
        url: "http://127.0.0.1:43133",
        close: closeHarnessHost,
        forceClose: forceCloseHarnessHost,
      });
      const closeStartedAt = Date.now();
      const closeError = await closing.catch((error) => error);
      const closeElapsedMs = Date.now() - closeStartedAt;
      expect(closeError).toBeInstanceOf(AggregateError);
      expect(closeError.errors[0]?.code).toBe("RELAYER_RUNTIME_STARTUP_CLEANUP_TIMEOUT");
      expect(closeElapsedMs).toBeLessThan(200);
      expect((await startingOutcome).message).toBe("GraphComplete runtime is shutting down.");
      expect(closeHarnessHost).toHaveBeenCalledOnce();
      expect(forceCloseHarnessHost).toHaveBeenCalledOnce();
      expect(service.deferredCleanupFences.size).toBe(1);
      expect(service.harnessHost).toBeNull();
      expect(service.session).toBeNull();
    } finally {
      resolveHarnessHost?.({
        url: "http://127.0.0.1:43133",
        close: closeHarnessHost,
        forceClose: forceCloseHarnessHost,
      });
      delete globalThis[hookName];
      await service.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("force-closes an established harness host when graceful close never settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-runtime-established-host-close-"));
    const hookName = `__relayerRuntimeEstablishedClose${Date.now()}${Math.random().toString(16).slice(2)}`;
    let rejectGracefulClose;
    const gracefulClosePending = new Promise((_resolve, reject) => { rejectGracefulClose = reject; });
    const closeHarnessHost = vi.fn(() => gracefulClosePending);
    const forceCloseError = new Error("forced harness close failed");
    const forceCloseHarnessHost = vi.fn(() => { throw forceCloseError; });
    globalThis[hookName] = {
      startHarnessHost: async () => ({
        url: "http://127.0.0.1:43131",
        close: closeHarnessHost,
        forceClose: forceCloseHarnessHost,
      }),
    };
    const harnessModule = `data:text/javascript,${encodeURIComponent(`
      export const digestHarnessConfiguration = () => "digest";
      export const createCodexBasicFactory = () => ({});
      export const loadHarnessConfigurations = async () => new Map();
      export const productHarnessImplementations = () => ({});
      export const startHarnessHost = (...args) => globalThis[${JSON.stringify(hookName)}].startHarnessHost(...args);
    `)}`;
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(function kill(signal) {
        this.signalCode = signal;
        this.emit("exit", null, signal);
        this.emit("close", null, signal);
        return true;
      }),
    });
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: harnessModule,
      spawnProcess: () => {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ ready: true, url: "http://127.0.0.1:43130" })}\n`));
        return child;
      },
      shutdownTimeoutMs: 10,
    });
    const lateGracefulError = new Error("graceful host close rejected after force close");

    try {
      await service.start();
      const closing = service.close();
      let closeTimeout;
      const closeOutcome = await Promise.race([
        closing.then(
          () => ({ status: "fulfilled" }),
          (error) => ({ status: "rejected", error }),
        ),
        new Promise((resolve) => {
          closeTimeout = setTimeout(() => resolve({ status: "timed-out" }), 250);
        }),
      ]);
      clearTimeout(closeTimeout);
      expect(closeOutcome.status).toBe("rejected");
      expect(closeOutcome.error).toBeInstanceOf(AggregateError);
      const resourceErrors = closeOutcome.error.errors.flatMap((error) => error instanceof AggregateError ? error.errors : [error]);
      expect(resourceErrors[0]?.code).toBe("RELAYER_RUNTIME_HARNESS_CLOSE_TIMEOUT");
      expect(resourceErrors[1]).toBe(forceCloseError);
      expect(closeHarnessHost).toHaveBeenCalledOnce();
      expect(forceCloseHarnessHost).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      expect(service.deferredCleanupFences.size).toBe(1);

      rejectGracefulClose(lateGracefulError);
      await new Promise((resolve) => setImmediate(resolve));
      expect(closeHarnessHost).toHaveBeenCalledOnce();
      expect(forceCloseHarnessHost).toHaveBeenCalledOnce();
      expect(service.deferredCleanupFences.size).toBe(0);
      expect(service.harnessHost).toBeNull();
      expect(service.session).toBeNull();
    } finally {
      rejectGracefulClose?.(lateGracefulError);
      delete globalThis[hookName];
      await service.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares one shutdown deadline between a stalled harness host and an unkillable graph", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-graph-runtime-shared-close-deadline-"));
    const hookName = `__relayerRuntimeSharedCloseDeadline${Date.now()}${Math.random().toString(16).slice(2)}`;
    const shutdownTimeoutMs = 30;
    const closeHarnessHost = vi.fn(() => new Promise(() => {}));
    const forceCloseHarnessHost = vi.fn(() => new Promise(() => {}));
    globalThis[hookName] = {
      startHarnessHost: async () => ({
        url: "http://127.0.0.1:43134",
        close: closeHarnessHost,
        forceClose: forceCloseHarnessHost,
      }),
    };
    const harnessModule = `data:text/javascript,${encodeURIComponent(`
      export const digestHarnessConfiguration = () => "digest";
      export const createCodexBasicFactory = () => ({});
      export const loadHarnessConfigurations = async () => new Map();
      export const productHarnessImplementations = () => ({});
      export const startHarnessHost = (...args) => globalThis[${JSON.stringify(hookName)}].startHarnessHost(...args);
    `)}`;
    const child = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    const service = new GraphCompleteRuntimeService({
      userDataDirectory: directory,
      graphServerBinary: "/test/bin/relayer-graph-server",
      configurationPaths: [],
      harnessHostModuleUrl: harnessModule,
      spawnProcess: () => {
        queueMicrotask(() => child.stdout.write(`${JSON.stringify({ ready: true, url: "http://127.0.0.1:43135" })}\n`));
        return child;
      },
      shutdownTimeoutMs,
    });

    try {
      await service.start();
      const startedAt = Date.now();
      const closeError = await service.close().catch((error) => error);
      const elapsedMs = Date.now() - startedAt;
      expect(closeError).toBeInstanceOf(AggregateError);
      expect(elapsedMs).toBeGreaterThanOrEqual(shutdownTimeoutMs - 10);
      expect(elapsedMs).toBeLessThan(shutdownTimeoutMs * 4);
      expect(closeError.errors).toHaveLength(1);
      expect(closeError.errors[0]).toBeInstanceOf(AggregateError);
      expect(closeError.errors[0].errors.map((error) => error?.code)).toEqual([
        "RELAYER_RUNTIME_HARNESS_CLOSE_TIMEOUT",
        "RELAYER_CHILD_SHUTDOWN_TIMEOUT",
      ]);
      expect(closeHarnessHost).toHaveBeenCalledOnce();
      expect(forceCloseHarnessHost).toHaveBeenCalledOnce();
      expect(child.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGKILL"]);
    } finally {
      delete globalThis[hookName];
      await service.close().catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never substitutes an ambient Codex executable for a missing managed runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-ambient-codex-"));
    try {
      await writeFile(join(directory, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await expect(findCodexExecutable({
        RELAYER_CODEX_BINARY: join(directory, "missing-managed-codex"),
        PATH: directory,
      })).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
      spawnProcess: () => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
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
    const abortController = new AbortController();
    const canceled = client.request("never-respond", {}, 1_000, abortController.signal);
    abortController.abort(new Error("catalog refresh canceled"));
    await expect(canceled).rejects.toThrow("catalog refresh canceled");
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
        failedChild.kill = vi.fn((signal) => {
          failedChild.killed = true;
          failedChild.signalCode = signal;
          queueMicrotask(() => failedChild.emit("exit", null, signal));
          return true;
        });
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
        queueMicrotask(() => failedChild.emit("spawn"));
        return failedChild;
      },
    });
    expect(await failingClient.account()).toMatchObject({
      status: "unavailable", error: "Codex subscription is unavailable.",
    });
    expect(await failingClient.account()).toMatchObject({
      status: "unavailable", error: "Codex subscription is unavailable.",
    });
    expect(failedStarts).toBe(2);

    const stubbornCodex = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
    });
    stubbornCodex.stdin = new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(String(chunk));
      if (request.id !== undefined) {
        const result = request.method === "account/read" ? { account: null } : {};
        queueMicrotask(() => stubbornCodex.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));
      }
      callback();
    } });
    stubbornCodex.kill = vi.fn((signal) => {
      if (signal === "SIGKILL") {
        stubbornCodex.signalCode = signal;
        queueMicrotask(() => stubbornCodex.emit("exit", null, signal));
      }
      return true;
    });
    const closingClient = new CodexCredentialAdapter({
      environment: { RELAYER_CODEX_BINARY: "/usr/bin/true", PATH: "" },
      shutdownTimeoutMs: 5,
      spawnProcess: () => {
        queueMicrotask(() => stubbornCodex.emit("spawn"));
        return stubbornCodex;
      },
    });
    expect(await closingClient.account()).toMatchObject({ status: "disconnected" });
    await closingClient.close();
    expect(stubbornCodex.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);

    const neverSpawned = vi.fn();
    const closedWhileDiscovering = new CodexCredentialAdapter({
      environment: { RELAYER_CODEX_BINARY: "/usr/bin/true", PATH: "" },
      spawnProcess: neverSpawned,
    });
    const pendingAccount = closedWhileDiscovering.account();
    await closedWhileDiscovering.close();
    await expect(pendingAccount).resolves.toMatchObject({
      status: "unavailable",
      error: "Codex subscription is unavailable.",
    });
    expect(neverSpawned).not.toHaveBeenCalled();

    const spawnErrorChild = Object.assign(new EventEmitter(), {
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
    });
    spawnErrorChild.kill = vi.fn((signal) => {
      spawnErrorChild.signalCode = signal;
      queueMicrotask(() => spawnErrorChild.emit("close", null, signal));
      return true;
    });
    const spawnFailure = new CodexCredentialAdapter({
      environment: { RELAYER_CODEX_BINARY: "/usr/bin/true", PATH: "" },
      spawnProcess: () => {
        queueMicrotask(() => spawnErrorChild.emit("error", new Error("spawn EACCES")));
        return spawnErrorChild;
      },
    });
    await expect(spawnFailure.account()).resolves.toMatchObject({
      status: "unavailable",
      error: "Codex subscription is unavailable.",
    });
    expect(spawnErrorChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("drives the packaged update lifecycle through one state service", async () => {
    expect(resolveUpdateChannel(undefined)).toBe("stable");
    expect(resolveUpdateChannel("stable")).toBe("stable");
    expect(resolveUpdateChannel("preview")).toBe("preview");
    expect(resolveUpdateChannel("invalid")).toBe("stable");
    expect(packagedDesktopReleaseMetadata({
      relayerArtifactMode: "release",
      relayerUpdateChannel: "preview",
      relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL,
      relayerReleaseTarget: "macos-arm64",
      relayerReleasePlatform: "macos",
      relayerReleaseArchitecture: "arm64",
    }, { platform: "darwin", architecture: "arm64" })).toEqual({ channel: "preview", updateBaseUrl: DESKTOP_UPDATE_BASE_URL, targetKey: "macos-arm64" });
    expect(packagedDesktopReleaseMetadata({
      relayerArtifactMode: "release",
      relayerUpdateChannel: "stable",
      relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL,
      relayerReleaseTarget: "macos-arm64",
      relayerReleasePlatform: "macos",
      relayerReleaseArchitecture: "arm64",
    }, { platform: "darwin", architecture: "arm64" })).toEqual({ channel: "stable", updateBaseUrl: DESKTOP_UPDATE_BASE_URL, targetKey: "macos-arm64" });
    expect(packagedDesktopReleaseMetadata({
      relayerArtifactMode: "release",
      relayerUpdateChannel: "preview",
      relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URLS["windows-x64"],
      relayerReleaseTarget: "windows-x64",
      relayerReleasePlatform: "windows",
      relayerReleaseArchitecture: "x64",
    }, { platform: "win32", architecture: "x64" })).toEqual({
      channel: "preview",
      updateBaseUrl: DESKTOP_UPDATE_BASE_URLS["windows-x64"],
      targetKey: "windows-x64",
    });
    for (const metadata of [
      { relayerArtifactMode: "development", relayerUpdateChannel: "preview", relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL },
      { relayerArtifactMode: "release", relayerUpdateChannel: "beta", relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL },
      { relayerArtifactMode: "release", relayerUpdateChannel: "preview", relayerUpdateBaseUrl: "https://example.test" },
      { relayerArtifactMode: "release", relayerUpdateChannel: "preview", relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL },
    ]) {
      expect(packagedDesktopReleaseMetadata(metadata)).toBeNull();
    }
    const armReleaseMetadata = {
      relayerArtifactMode: "release",
      relayerUpdateChannel: "preview",
      relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URL,
      relayerReleaseTarget: "macos-arm64",
      relayerReleasePlatform: "macos",
      relayerReleaseArchitecture: "arm64",
    };
    expect(packagedDesktopReleaseMetadata(
      { ...armReleaseMetadata, relayerReleasePlatform: "windows" },
      { platform: "darwin", architecture: "arm64" },
    )).toBeNull();
    expect(packagedDesktopReleaseMetadata(
      { ...armReleaseMetadata, relayerReleaseArchitecture: "x64" },
      { platform: "darwin", architecture: "arm64" },
    )).toBeNull();
    expect(packagedDesktopReleaseMetadata(
      armReleaseMetadata,
      { platform: "darwin", architecture: "x64" },
    )).toBeNull();

    const autoUpdater = Object.assign(new EventEmitter(), {
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      setFeedURL: vi.fn(),
      quitAndInstall: vi.fn(),
    });
    let selectedProviderChannel = null;
    Object.defineProperty(autoUpdater, "channel", {
      configurable: true,
      get: () => selectedProviderChannel,
      set(value) {
        selectedProviderChannel = value;
        // Match electron-updater: choosing a channel opts into downgrades.
        autoUpdater.allowDowngrade = true;
      },
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
    expect(autoUpdater.allowDowngrade).toBe(false);
    expect(updater.setChannel("preview")).toMatchObject({ phase: "idle", channel: "preview" });
    expect(autoUpdater.channel).toBe("beta");
    expect(autoUpdater.allowDowngrade).toBe(false);
    autoUpdater.emit("checking-for-update");
    expect(() => updater.setChannel("stable")).toThrow("Finish the current update");
    autoUpdater.emit("update-available", { version: "0.1.1" });
    expect(() => updater.setChannel("stable")).toThrow("Finish the current update");
    await updater.download();
    autoUpdater.emit("download-progress", { percent: 29.4 });
    autoUpdater.emit("download-progress", { percent: 100 });
    autoUpdater.emit("download-progress", { percent: 16.2 });
    autoUpdater.emit("download-progress", { percent: 92 });
    autoUpdater.emit("update-downloaded", { version: "0.1.1" });
    autoUpdater.emit("download-progress", { percent: 3 });
    updater.install();

    expect(states.filter((state) => state.phase === "downloading").map((state) => state.percent)).toEqual([29, 99, 99, 99]);
    expect(states.at(-1)).toMatchObject({ phase: "ready", percent: 100 });
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith(expect.objectContaining({ channel: "beta" }));
    expect(autoUpdater.allowDowngrade).toBe(false);
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledOnce();
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("suppresses macOS updates below the manifest's Darwin kernel floor", async () => {
    const updateInfo = { version: "0.3.0", minimumSystemVersion: "22.4.0" };
    const unsupportedHosts = [
      { macOS: "13.0", release: "22.1.0" },
      { macOS: "13.1", release: "22.2.0" },
      { macOS: "13.2", release: "22.3.0" },
    ];
    for (const { release } of unsupportedHosts) {
      expect(desktopUpdateSupportsSystem(updateInfo, { platform: "darwin", release })).toBe(false);
    }
    expect(desktopUpdateSupportsSystem(updateInfo, { platform: "darwin", release: "22.4.0" })).toBe(true);
    expect(desktopUpdateSupportsSystem(updateInfo, { platform: "darwin", release: "23.0.0" })).toBe(true);
    expect(desktopUpdateSupportsSystem({}, { platform: "darwin", release: "22.3.0" })).toBe(false);
    expect(desktopUpdateSupportsSystem(updateInfo, { platform: "darwin", release: "unknown" })).toBe(false);
    expect(desktopUpdateSupportsSystem(updateInfo, { platform: "win32", release: "10.0.0" })).toBe(true);

    const updaterForRelease = (release) => {
      const autoUpdater = Object.assign(new EventEmitter(), {
        checkForUpdates: vi.fn(async () => undefined),
        downloadUpdate: vi.fn(async () => undefined),
        setFeedURL: vi.fn(),
        quitAndInstall: vi.fn(),
      });
      createDesktopUpdater({
        autoUpdater,
        app: { isPackaged: true, getVersion: () => "0.2.0" },
        emit: vi.fn(),
        updateBaseUrl: DESKTOP_UPDATE_BASE_URL,
        platform: "darwin",
        release,
      });
      return autoUpdater;
    };
    expect(updaterForRelease("22.3.0").isUpdateSupported(updateInfo)).toBe(false);
    expect(updaterForRelease("22.4.0").isUpdateSupported(updateInfo)).toBe(true);
  });

  it("records packaged canary updater states as restart-safe JSON lines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-canary-log-"));
    const outputPath = join(directory, "update.jsonl");
    try {
      const log = createCanaryEvidenceLog({
        environment: { RELAYER_DESKTOP_CANARY_LOG: outputPath },
        appIsPackaged: true,
        releaseMetadata: { targetKey: "windows-x64" },
        platform: "win32",
        architecture: "x64",
        processId: 42,
        now: () => new Date("2026-08-18T20:00:00.000Z"),
      });
      expect(log).toMatchObject({ enabled: true, path: outputPath });
      await log.write({ phase: "available", version: "0.2.4", availableVersion: "0.2.5", channel: "preview" });
      await log.write({ phase: "ready", version: "0.2.4", availableVersion: "0.2.5", channel: "preview" });
      await log.flush();
      const records = (await readFile(outputPath, "utf8")).trim().split("\n").map(JSON.parse);
      expect(records).toEqual([
        expect.objectContaining({
          schemaVersion: 1,
          capturedAt: "2026-08-18T20:00:00.000Z",
          processId: 42,
          target: "windows-x64",
          platform: "win32",
          architecture: "x64",
          state: expect.objectContaining({ phase: "available", availableVersion: "0.2.5" }),
        }),
        expect.objectContaining({ state: expect.objectContaining({ phase: "ready", availableVersion: "0.2.5" }) }),
      ]);

      expect(createCanaryEvidenceLog({
        environment: { RELAYER_DESKTOP_CANARY_LOG: outputPath },
        appIsPackaged: false,
        releaseMetadata: { targetKey: "windows-x64" },
      }).enabled).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("quiesces any installer-launched seed before starting the evidence-bearing Windows process", async () => {
    const script = await readFile(new URL("../desktop/release/run-windows-canary.ps1", import.meta.url), "utf8");
    const silentSeedInstall = script.indexOf('Start-Process -FilePath $SeedInstaller -ArgumentList "/S" -Wait');
    const stopAfterInstall = script.indexOf("Stop-Relayer", silentSeedInstall);
    const evidenceEnvironment = script.indexOf("$env:RELAYER_DESKTOP_CANARY_LOG", stopAfterInstall);
    const canaryLaunch = script.indexOf("$seedProcess = Start-Process", evidenceEnvironment);

    expect(silentSeedInstall).toBeGreaterThan(-1);
    expect(stopAfterInstall).toBeGreaterThan(silentSeedInstall);
    expect(evidenceEnvironment).toBeGreaterThan(stopAfterInstall);
    expect(canaryLaunch).toBeGreaterThan(evidenceEnvironment);
  });

  it("audits live desktop release authority without reading secret values", async () => {
    const [mainRuleset, tagRuleset] = await Promise.all([
      readFile(new URL("../infra/github/desktop-release-authority/main-ruleset.json", import.meta.url), "utf8").then(JSON.parse),
      readFile(new URL("../infra/github/desktop-release-authority/desktop-tags-ruleset.json", import.meta.url), "utf8").then(JSON.parse),
    ]);
    const environment = ({ branches, secrets = [], variables = [] }) => ({
      protection_rules: [{ type: "branch_policy" }],
      branches,
      secrets,
      variables,
    });
    const snapshot = {
      repository: { default_branch: "main", permissions: { admin: true } },
      repositoryVariables: [
        "DESKTOP_UPDATE_BUCKET",
        "DESKTOP_UPDATE_PREVIEW_ROLE_ARN",
        "DESKTOP_UPDATE_STABLE_ROLE_ARN",
      ],
      oidc: {
        use_default: true,
        sub_claim_prefix: "repo:vishaltandale00@9222298/relayer-graphcomplete@1327816644",
      },
      environments: {
        "desktop-production": environment({
          branches: ["main", "desktop-v*"],
          secrets: [
            "RELAYER_DESKTOP_APPLE_API_ISSUER",
            "RELAYER_DESKTOP_APPLE_API_KEY",
            "RELAYER_DESKTOP_APPLE_API_KEY_ID",
            "RELAYER_DESKTOP_CSC_KEY_PASSWORD",
            "RELAYER_DESKTOP_CSC_LINK",
            "RELAYER_DESKTOP_SIGN_IDENTITY",
          ],
        }),
        "desktop-production-windows": environment({
          branches: ["main", "desktop-v*"],
          variables: [
            "AZURE_CLIENT_ID",
            "AZURE_SUBSCRIPTION_ID",
            "AZURE_TENANT_ID",
            "RELAYER_WINDOWS_CERTIFICATE_PROFILE",
            "RELAYER_WINDOWS_PUBLISHER_NAME",
          ],
        }),
        "desktop-update-preview": environment({ branches: ["desktop-v*"] }),
        "desktop-update-stable-promotion": environment({ branches: ["main"] }),
      },
      rulesets: [mainRuleset, tagRuleset],
    };

    expect(evaluateDesktopReleaseAuthority(snapshot).every((result) => result.passed)).toBe(true);
    snapshot.environments["desktop-production-windows"].variables.pop();
    mainRuleset.enforcement = "disabled";
    const disabledWindowsFailures = evaluateDesktopReleaseAuthority(snapshot).filter((result) => !result.passed);
    expect(disabledWindowsFailures.map((failure) => failure.label)).not.toContain(
      "environment desktop-production-windows has required variable names",
    );
    const failures = evaluateDesktopReleaseAuthority(snapshot, { windowsCandidateEnabled: true })
      .filter((result) => !result.passed);
    expect(failures.map((failure) => failure.label)).toEqual(expect.arrayContaining([
      "environment desktop-production-windows has required variable names",
      "an active ruleset targets main",
      "main requires the current GitHub Actions check job",
    ]));
  });

  it("seals Windows canary evidence to the published candidate and a real updater relaunch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-canary-evidence-"));
    try {
      const version = "0.2.5";
      const seedVersion = "0.2.4";
      const sourceCommit = "d".repeat(40);
      const name = `Relayer-${version}-win-x64.exe`;
      const artifact = {
        name,
        size: 123,
        sha256: "e".repeat(64),
        sha512: "signed-installer-sha512",
      };
      const targetReceiptPath = join(directory, "target-release.json");
      const publicationReceiptPath = join(directory, "preview-publication.json");
      const seedReceiptPath = join(directory, "seed-release.json");
      const stateLogPath = join(directory, "update.jsonl");
      const outputPath = join(directory, "windows-preview-canary.json");
      const screenshots = {
        firstInstall: join(directory, "first-install.png"),
        available: join(directory, "available.png"),
        ready: join(directory, "ready.png"),
        installed: join(directory, "installed.png"),
      };
      await Promise.all([
        writeFile(targetReceiptPath, JSON.stringify({
          schemaVersion: 2,
          product: "Relayer",
          appId: DESKTOP_RELEASE.productionAppId,
          version,
          target: "windows-x64",
          platform: "windows",
          architecture: "x64",
          minimumMacOSVersion: null,
          channel: "preview",
          manifest: "beta.yml",
          updateBaseUrl: DESKTOP_RELEASE_TARGETS["windows-x64"].updateBaseUrl,
          sourceCommit,
          signing: {
            mode: "azure-artifact-signing",
            endpoint: DESKTOP_RELEASE.artifactSigningEndpoint,
            accountName: DESKTOP_RELEASE.artifactSigningAccountName,
            certificateProfileName: "relayer-public-trust",
            publisherName: WINDOWS_PUBLISHER_DN,
          },
          artifacts: [artifact],
        })),
        writeFile(publicationReceiptPath, JSON.stringify({
          schemaVersion: 2,
          channel: "preview",
          target: "windows-x64",
          version,
          sourceCommit,
          workflowRunId: "12345",
          artifacts: [artifact],
        })),
        writeFile(seedReceiptPath, JSON.stringify({
          schemaVersion: 2,
          product: DESKTOP_RELEASE.productName,
          appId: DESKTOP_RELEASE.productionAppId,
          version: seedVersion,
          target: "windows-x64",
          platform: "windows",
          architecture: "x64",
          minimumMacOSVersion: null,
          channel: "preview",
          manifest: "beta.yml",
          updateBaseUrl: DESKTOP_RELEASE_TARGETS["windows-x64"].updateBaseUrl,
          sourceCommit: "c".repeat(40),
          signing: {
            mode: "azure-artifact-signing",
            endpoint: DESKTOP_RELEASE.artifactSigningEndpoint,
            accountName: DESKTOP_RELEASE.artifactSigningAccountName,
            certificateProfileName: "relayer-public-trust",
            publisherName: WINDOWS_PUBLISHER_DN,
          },
          artifacts: [{
            name: `Relayer-${seedVersion}-win-x64.exe`,
            size: 122,
            sha256: "f".repeat(64),
            sha512: "signed-seed-installer-sha512",
          }],
        })),
        writeFile(stateLogPath, [
          { schemaVersion: 1, capturedAt: "2026-08-18T20:00:00.000Z", target: "windows-x64", platform: "win32", architecture: "x64", processId: 100, state: { phase: "idle", version: seedVersion, channel: "preview", error: null } },
          { schemaVersion: 1, capturedAt: "2026-08-18T20:00:01.000Z", target: "windows-x64", platform: "win32", architecture: "x64", processId: 100, state: { phase: "available", version: seedVersion, availableVersion: version, channel: "preview", error: null } },
          { schemaVersion: 1, capturedAt: "2026-08-18T20:00:02.000Z", target: "windows-x64", platform: "win32", architecture: "x64", processId: 100, state: { phase: "downloading", version: seedVersion, availableVersion: version, channel: "preview", percent: 22, error: null } },
          { schemaVersion: 1, capturedAt: "2026-08-18T20:00:03.000Z", target: "windows-x64", platform: "win32", architecture: "x64", processId: 100, state: { phase: "downloading", version: seedVersion, availableVersion: version, channel: "preview", percent: 99, error: null } },
          { schemaVersion: 1, capturedAt: "2026-08-18T20:00:04.000Z", target: "windows-x64", platform: "win32", architecture: "x64", processId: 100, state: { phase: "ready", version: seedVersion, availableVersion: version, channel: "preview", error: null } },
          { schemaVersion: 1, capturedAt: "2026-08-18T20:00:05.000Z", target: "windows-x64", platform: "win32", architecture: "x64", processId: 200, state: { phase: "idle", version, channel: "preview", error: null } },
        ].map(JSON.stringify).join("\n")),
        ...Object.entries(screenshots).map(([name, path]) => writeFile(path, `${name}-image`)),
      ]);

      const derivedTrace = deriveDesktopCanaryTrace({
        text: await readFile(stateLogPath, "utf8"),
        target: DESKTOP_RELEASE_TARGETS["windows-x64"],
        version,
      });
      expect(derivedTrace).toMatchObject({ seedProcessId: 100, targetProcessId: 200 });

      await expect(createDesktopCanaryEvidence({
        targetReleaseReceiptPath: targetReceiptPath,
        previewPublicationReceiptPath: publicationReceiptPath,
        seedReleaseReceiptPath: seedReceiptPath,
        stateLogPath,
        screenshotPaths: screenshots,
        outputPath,
        environment: { host: "avd-relayer-win11", os: "Windows 11 24H2", architecture: "x64" },
        running: true,
        codeSignatureVerified: true,
        platformAcceptanceVerified: true,
      })).resolves.toMatchObject({
        schemaVersion: 2,
        environment: { target: "windows-x64", architecture: "x64" },
        seed: { version: seedVersion },
        target: {
          version,
          sourceCommit,
          workflowRunId: "12345",
          artifactSha256: { [name]: artifact.sha256 },
        },
        postUpdate: {
          installedVersion: version,
          running: true,
          codeSignatureVerified: true,
          channel: "preview",
          updateStatus: "idle",
        },
      });
      expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
        screenshots: {
          firstInstall: { file: "first-install.png", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
          available: { file: "available.png", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
          ready: { file: "ready.png", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
          installed: { file: "installed.png", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        },
      });
      await writeFile(screenshots.ready, "available-image");
      await expect(createDesktopCanaryEvidence({
        targetReleaseReceiptPath: targetReceiptPath,
        previewPublicationReceiptPath: publicationReceiptPath,
        seedReleaseReceiptPath: seedReceiptPath,
        stateLogPath,
        screenshotPaths: screenshots,
        outputPath,
        environment: { host: "avd-relayer-win11", os: "Windows 11 24H2", architecture: "x64" },
        running: true,
        codeSignatureVerified: true,
        platformAcceptanceVerified: true,
      })).rejects.toThrow("Canary available, ready, and installed screenshots must be visually distinct.");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pins Preview publication to one successful manual candidate attempt and artifact", async () => {
    const sourceCommit = "a".repeat(40);
    const repository = "vishaltandale00/relayer-graphcomplete";
    const artifactDigest = `sha256:${"b".repeat(64)}`;
    const tagArtifactLine = `Candidate-Artifact-macos-arm64: 777/${artifactDigest}`;
    expect(parseDesktopPreviewCandidateTag({
      objectType: "tag",
      message: `Relayer Desktop 0.2.26\n\nCandidate-Run: 12345/2\n${tagArtifactLine}\n`,
      version: "0.2.26",
    })).toEqual({
      candidateRunId: "12345",
      candidateRunAttempt: "2",
      candidateArtifacts: { "macos-arm64": { id: "777", digest: artifactDigest } },
    });
    expect(() => parseDesktopPreviewCandidateTag({
      objectType: "commit",
      message: `Relayer Desktop 0.2.26\n\nCandidate-Run: 12345/2\n${tagArtifactLine}\n`,
      version: "0.2.26",
    })).toThrow("annotated release tag");
    for (const message of [
      `Relayer Desktop 0.2.26\n\nCandidate-Run: 12345/2\nCandidate-Run: 67890/1\n${tagArtifactLine}\n`,
      `Relayer Desktop 0.2.26\n\nCandidate-Run: 12345/2\n candidate-run: 67890/1\n${tagArtifactLine}\n`,
      `Relayer Desktop 0.2.26\n\nCandidate-Run: 12345/2\nCANDIDATE-RUN: 67890/1\n${tagArtifactLine}\n`,
    ]) {
      expect(() => parseDesktopPreviewCandidateTag({ objectType: "tag", message, version: "0.2.26" }))
        .toThrow("exactly one Candidate-Run");
    }

    const run = {
      id: 12345,
      run_attempt: 2,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
      head_sha: sourceCommit,
      head_branch: "main",
      path: ".github/workflows/desktop-signed-preview.yml",
      repository: { full_name: repository },
    };
    const artifactName = `relayer-desktop-preview-macos-arm64-${sourceCommit}`;
    const artifact = { id: 777, name: artifactName, expired: false, digest: artifactDigest };
    const jobs = { jobs: [{
      name: "Sign and notarize macos-arm64 Preview",
      status: "completed",
      conclusion: "success",
    }] };
    const artifacts = { artifacts: [artifact] };
    const pinnedCandidateArtifacts = { "macos-arm64": { id: "777", digest: artifactDigest } };
    const expectedCandidateArtifacts = {
      "macos-arm64": { id: "777", name: artifactName, digest: artifact.digest },
    };
    expect(validateDesktopPreviewCandidateRun({
      run,
      jobs,
      artifacts,
      candidateRunId: "12345",
      candidateRunAttempt: "2",
      candidateArtifacts: pinnedCandidateArtifacts,
      sourceCommit,
      repository,
    })).toEqual({
      candidateRunId: "12345",
      candidateRunAttempt: "2",
      candidateArtifacts: expectedCandidateArtifacts,
    });
    const candidateWorkflow = parseYaml(await readFile(
      new URL("../.github/workflows/desktop-signed-preview.yml", import.meta.url),
      "utf8",
    ));
    for (const [target, jobName] of [
      ["macos-x64", candidateWorkflow.jobs["package-macos"].name.replace("${{ matrix.target }}", "macos-x64")],
      ["windows-x64", candidateWorkflow.jobs["package-windows"].name],
    ]) {
      const targetArtifactName = `relayer-desktop-preview-${target}-${sourceCommit}`;
      expect(validateDesktopPreviewCandidateRun({
        run,
        jobs: { jobs: [{ name: jobName, status: "completed", conclusion: "success" }] },
        artifacts: { artifacts: [{ ...artifact, name: targetArtifactName }] },
        candidateRunId: "12345",
        candidateRunAttempt: "2",
        candidateArtifacts: { [target]: { id: "777", digest: artifactDigest } },
        sourceCommit,
        repository,
        targets: [target],
      }).candidateArtifacts[target]).toEqual({
        id: "777",
        name: targetArtifactName,
        digest: artifactDigest,
      });
    }
    const invalidRuns = [
      [{ ...run, id: 12346 }, "12345", "2"],
      [{ ...run, run_attempt: 3 }, "12345", "2"],
      [{ ...run, event: "push" }, "12345", "2"],
      [{ ...run, status: "in_progress" }, "12345", "2"],
      [{ ...run, head_sha: "c".repeat(40) }, "12345", "2"],
      [{ ...run, head_branch: "release" }, "12345", "2"],
      [{ ...run, path: ".github/workflows/other.yml" }, "12345", "2"],
      [{ ...run, repository: { full_name: "other/repository" } }, "12345", "2"],
    ];
    for (const [candidateRun, candidateRunId, candidateRunAttempt] of invalidRuns) {
      expect(() => validateDesktopPreviewCandidateRun({
        run: candidateRun,
        jobs,
        artifacts,
        candidateRunId,
        candidateRunAttempt,
        candidateArtifacts: pinnedCandidateArtifacts,
        sourceCommit,
        repository,
      })).toThrow("completed manual run");
    }
    expect(() => validateDesktopPreviewCandidateRun({
      run,
      jobs: { jobs: [{ ...jobs.jobs[0], conclusion: "failure" }] },
      artifacts,
      candidateRunId: "12345",
      candidateRunAttempt: "2",
      candidateArtifacts: pinnedCandidateArtifacts,
      sourceCommit,
      repository,
    })).toThrow("successful macos-arm64 package job");
    expect(() => validateDesktopPreviewCandidateRun({
      run,
      jobs,
      artifacts: { artifacts: [{ name: artifactName, expired: true }] },
      candidateRunId: "12345",
      candidateRunAttempt: "2",
      candidateArtifacts: pinnedCandidateArtifacts,
      sourceCommit,
      repository,
    })).toThrow("exact unexpired");
    expect(() => validateDesktopPreviewCandidateRun({
      run,
      jobs,
      artifacts: { artifacts: [artifact, { ...artifact }] },
      candidateRunId: "12345",
      candidateRunAttempt: "2",
      candidateArtifacts: pinnedCandidateArtifacts,
      sourceCommit,
      repository,
    })).toThrow("exact unexpired");
    for (const invalidPinnedArtifact of [
      { id: "0", digest: artifactDigest },
      { id: "777", digest: "sha256:not-a-digest" },
    ]) {
      expect(() => validateDesktopPreviewCandidateRun({
        run,
        jobs,
        artifacts,
        candidateRunId: "12345",
        candidateRunAttempt: "2",
        candidateArtifacts: { "macos-arm64": invalidPinnedArtifact },
        sourceCommit,
        repository,
      })).toThrow(/positive integer|SHA-256 digest/);
    }

    const environment = {
      RELAYER_DESKTOP_VERSION: "0.2.26",
      RELAYER_DESKTOP_TAG_OBJECT_TYPE: "tag",
      RELAYER_DESKTOP_TAG_MESSAGE: `Relayer Desktop 0.2.26\n\nCandidate-Run: 12345/2\n${tagArtifactLine}\n`,
      GITHUB_REPOSITORY: repository,
      GITHUB_TOKEN: "test-token",
      GITHUB_SHA: sourceCommit,
    };
    const fetchImpl = async (url) => {
      if (String(url).endsWith("/jobs?per_page=100")) {
        expect(String(url)).toContain("/runs/12345/attempts/2/jobs?per_page=100");
        return new Response(JSON.stringify(jobs), { status: 200 });
      }
      return new Response(JSON.stringify(
        String(url).endsWith("/artifacts?per_page=100") ? artifacts : run,
      ), { status: 200 });
    };
    const resolved = await resolveDesktopPreviewCandidateRun({ environment, fetchImpl });
    expect(resolved.candidateArtifacts).toEqual(expectedCandidateArtifacts);
    const outputDirectory = await mkdtemp(join(tmpdir(), "relayer-candidate-output-"));
    try {
      const outputPath = join(outputDirectory, "github-output");
      await writeDesktopPreviewCandidateOutputs(outputPath, resolved);
      const output = await readFile(outputPath, "utf8");
      expect(output).toContain("candidate_run_id=12345\n");
      expect(output).toContain("candidate_run_attempt=2\n");
      const candidateArtifactsOutput = output.split("\n")
        .find((line) => line.startsWith("candidate_artifacts="));
      expect(JSON.parse(candidateArtifactsOutput.slice("candidate_artifacts=".length)))
        .toEqual(expectedCandidateArtifacts);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
    await expect(resolveDesktopPreviewCandidateRun({
      environment,
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    })).rejects.toThrow("GitHub returned HTTP 503");
    let runReads = 0;
    await expect(resolveDesktopPreviewCandidateRun({
      environment,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/jobs?per_page=100")) {
          return new Response(JSON.stringify(jobs), { status: 200 });
        }
        if (String(url).endsWith("/artifacts?per_page=100")) {
          return new Response(JSON.stringify(artifacts), { status: 200 });
        }
        runReads += 1;
        return new Response(JSON.stringify(runReads === 2 ? { ...run, run_attempt: 3 } : run), { status: 200 });
      },
    })).rejects.toThrow("completed manual run");
  });

  it("enforces one signed desktop release contract and seals its candidate artifacts", async () => {
    const releaseWorkflow = await readFile(new URL("../.github/workflows/desktop-signed-preview.yml", import.meta.url), "utf8");
    const stableWorkflow = await readFile(new URL("../.github/workflows/desktop-promote-stable.yml", import.meta.url), "utf8");
    const arm64CanaryWorkflow = await readFile(new URL("../.github/workflows/desktop-arm64-canary.yml", import.meta.url), "utf8");
    const intelCanaryWorkflow = await readFile(new URL("../.github/workflows/desktop-intel-canary.yml", import.meta.url), "utf8");
    const macOSCanaryScriptUrl = new URL("../desktop/release/run-macos-canary.sh", import.meta.url);
    const macOSCanaryScript = await readFile(macOSCanaryScriptUrl, "utf8");
    const arm64CanaryScript = await readFile(new URL("../desktop/release/run-macos-arm64-canary.sh", import.meta.url), "utf8");
    const intelCanaryScript = await readFile(new URL("../desktop/release/run-macos-intel-canary.sh", import.meta.url), "utf8");
    const electronCanaryScript = await readFile(new URL("../desktop/release/electron-cdp-canary.mjs", import.meta.url), "utf8");
    const notarizationScript = await readFile(new URL("../desktop/release/notarize-and-staple.mjs", import.meta.url), "utf8");
    const artifactRunIdsByStep = (workflow) => Object.fromEntries(
      parseYaml(workflow).jobs.canary.steps
        .filter((step) => step.with?.["run-id"])
        .map((step) => [step.name, step.with["run-id"]]),
    );
    expect(releaseWorkflow).toContain("if: ${{ always() && github.event_name == 'push' && needs.validate.result == 'success' && startsWith(github.ref, 'refs/tags/desktop-v') }}");
    expect(releaseWorkflow).toContain('git merge-base --is-ancestor "$GITHUB_SHA" refs/remotes/origin/main');
    expect(releaseWorkflow).toContain("RELAYER_DESKTOP_TAG_OBJECT_TYPE");
    expect(releaseWorkflow).toContain("artifact-ids: ${{ fromJSON(needs.validate.outputs.candidate_artifacts)[matrix.target].id }}");
    expect(releaseWorkflow).toContain("run-id: ${{ needs.validate.outputs.candidate_run_id }}");
    expect(releaseWorkflow).toContain("github-token: ${{ github.token }}");
    expect(releaseWorkflow).toContain("merge-multiple: true");
    expect(releaseWorkflow).toContain("RELAYER_DESKTOP_CANDIDATE_RUN_ID: ${{ needs.validate.outputs.candidate_run_id }}");
    expect(releaseWorkflow).toContain("RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: ${{ needs.validate.outputs.candidate_run_attempt }}");
    expect(releaseWorkflow).toContain("RELAYER_DESKTOP_CANDIDATE_RUN_ID: ${{ github.run_id }}");
    expect(releaseWorkflow).toContain("RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: ${{ github.run_attempt }}");
    expect(releaseWorkflow).toContain("RELAYER_DESKTOP_CANDIDATE_ARTIFACT_ID: ${{ fromJSON(needs.validate.outputs.candidate_artifacts)[matrix.target].id }}");
    expect(releaseWorkflow).toContain("RELAYER_DESKTOP_CANDIDATE_ARTIFACT_DIGEST: ${{ fromJSON(needs.validate.outputs.candidate_artifacts)[matrix.target].digest }}");
    expect(releaseWorkflow).toContain("if: ${{ github.event_name == 'workflow_dispatch' }}");
    expect(releaseWorkflow).toContain("uses: azure/login@f5d393ae46f8fde4be8b75f32e3fc50e654ad0ca");
    expect(releaseWorkflow).toContain("subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}");
    expect(releaseWorkflow).toContain("AZURE_CLIENT_ID: ${{ vars.AZURE_CLIENT_ID }}");
    expect(releaseWorkflow).toContain("RELAYER_WINDOWS_PUBLISHER_NAME: ${{ vars.RELAYER_WINDOWS_PUBLISHER_NAME }}");
    expect(releaseWorkflow).toContain("Missing required Windows signing variable");
    expect(releaseWorkflow).toContain("if: ${{ false }}");
    expect(releaseWorkflow).toContain("needs: [validate, package-macos]");
    expect(releaseWorkflow).toContain("target: [macos-arm64]");
    expect(releaseWorkflow).not.toContain("macos-15-intel");
    expect(releaseWorkflow).not.toContain("needs: [package-macos, package-windows]");
    expect(releaseWorkflow).not.toContain("AZURE_FEDERATED_TOKEN_FILE");
    expect(releaseWorkflow).toContain("environment:\n      name: desktop-update-preview");
    expect(stableWorkflow).toContain("workflow_dispatch:");
    expect(stableWorkflow).toContain("name: desktop-update-stable-promotion");
    expect(stableWorkflow).toContain("DESKTOP_UPDATE_STABLE_ROLE_ARN");
    expect(stableWorkflow).toContain("--canary-evidence");
    expect(arm64CanaryWorkflow).toMatch(/^    runs-on: macos-15$/m);
    expect(arm64CanaryWorkflow).toContain("run-macos-arm64-canary.sh");
    expect(arm64CanaryWorkflow).toContain("relayer-desktop-preview-macos-arm64-");
    expect(arm64CanaryWorkflow).toContain("preview-publication-macos-arm64");
    expect(artifactRunIdsByStep(arm64CanaryWorkflow)).toMatchObject({
      "Download signed Apple Silicon target candidate": "${{ inputs.target_candidate_run_id }}",
      "Download target Preview publication receipt": "${{ inputs.target_publication_run_id }}",
    });
    expect(arm64CanaryWorkflow).not.toContain("inputs.target_run_id");
    expect(arm64CanaryWorkflow).toContain("Relayer-${SEED_VERSION}-mac-arm64.dmg");
    expect(arm64CanaryWorkflow).toContain("- name: Preserve Apple Silicon install and updater evidence\n        if: ${{ always() }}");
    expect(intelCanaryWorkflow).toContain("runs-on: macos-15-intel");
    expect(intelCanaryWorkflow).toContain("run-macos-intel-canary.sh");
    expect(intelCanaryWorkflow).toContain("preview-publication-macos-x64");
    expect(artifactRunIdsByStep(intelCanaryWorkflow)).toMatchObject({
      "Download signed Intel target candidate": "${{ inputs.target_candidate_run_id }}",
      "Download target Preview publication receipt": "${{ inputs.target_publication_run_id }}",
    });
    expect(intelCanaryWorkflow).not.toContain("inputs.target_run_id");
    expect(intelCanaryWorkflow).toContain("- name: Preserve Intel install and updater evidence\n        if: ${{ always() }}");
    expect(intelCanaryScript).toContain('run-macos-canary.sh" --target macos-x64 "$@"');
    expect(arm64CanaryScript).toContain('run-macos-canary.sh" --target macos-arm64 "$@"');
    expect(macOSCanaryScript).toContain("spctl --assess --type open");
    expect(macOSCanaryScript).toContain('macos-x64)');
    expect(macOSCanaryScript).toContain('expected_host_architecture="x86_64"');
    expect(macOSCanaryScript).toContain('evidence_architecture="x64"');
    expect(macOSCanaryScript).toContain('evidence_prefix="macos-intel"');
    expect(macOSCanaryScript).toContain('macos-arm64)');
    expect(macOSCanaryScript).toContain('expected_host_architecture="arm64"');
    expect(macOSCanaryScript).toContain('evidence_architecture="arm64"');
    expect(macOSCanaryScript).toContain('evidence_prefix="macos-arm64"');
    expect(notarizationScript.indexOf('["stapler", "validate", dmgPath]')).toBeLessThan(notarizationScript.indexOf('"/usr/sbin/spctl"'));
    expect(macOSCanaryScript).toContain('launchctl setenv RELAYER_DESKTOP_USER_DATA_DIR "$update_user_data"');
    expect(macOSCanaryScript).toContain("trap preserve_failed_canary_diagnostics EXIT");
    expect(macOSCanaryScript).toContain('runtime_directory="$(mktemp -d');
    expect(macOSCanaryScript).toContain("--mode capture-installed");
    expect(macOSCanaryScript).toContain('updated_pid="$(target_process_id_from_trace');
    expect(macOSCanaryScript).toContain('terminate_process "$updated_pid" "Updater-relaunched Relayer"');
    expect(macOSCanaryScript).not.toContain('pkill -f "$application/Contents/MacOS/Relayer"');
    expect(macOSCanaryScript).toContain('${evidence_prefix}-preview-update.partial.jsonl');
    expect(macOSCanaryScript).toContain('install -m 600 "$live_state_log" "$state_log"');
    expect(electronCanaryScript).toContain('popover?.style.setProperty("display", "block", "important")');
    expect(electronCanaryScript).toContain('popover?.style.setProperty("z-index", "1000", "important")');
    expect(electronCanaryScript).toContain('shell?.style.setProperty("display", "flex", "important")');
    expect(electronCanaryScript).toContain('settings?.style.setProperty("display", "block", "important")');
    expect(electronCanaryScript).toContain('document.querySelector("#settingsButton")?.click()');
    expect(electronCanaryScript).toContain('document.querySelector(\'[data-settings-tab="updates"]\')?.click()');
    expect(electronCanaryScript).toContain('updateSection?.classList.remove("hidden")');
    expect(electronCanaryScript).toContain('section.querySelector("h2")?.textContent === "Application updates"');
    expect(electronCanaryScript).toContain("document.elementFromPoint(");
    expect(electronCanaryScript).toContain("getBoundingClientRect()");
    const updatedPidIndex = macOSCanaryScript.indexOf('updated_pid="$(target_process_id_from_trace');
    const updatedTerminateIndex = macOSCanaryScript.indexOf('terminate_process "$updated_pid" "Updater-relaunched Relayer"');
    const targetRelaunchIndex = macOSCanaryScript.indexOf("--remote-debugging-port=9230");
    const targetKillIndex = macOSCanaryScript.indexOf('kill "$target_pid"');
    const targetWaitIndex = macOSCanaryScript.indexOf('wait "$target_pid"');
    const processCheckIndex = macOSCanaryScript.indexOf('pgrep -f "$application/Contents/MacOS/Relayer"');
    const traceFreezeIndex = macOSCanaryScript.indexOf('install -m 600 "$live_state_log" "$state_log"');
    const evidenceSealIndex = macOSCanaryScript.lastIndexOf('node "$script_directory/canary-evidence.mjs"');
    expect(updatedPidIndex).toBeGreaterThan(-1);
    expect(updatedPidIndex).toBeLessThan(updatedTerminateIndex);
    expect(updatedTerminateIndex).toBeLessThan(targetRelaunchIndex);
    expect(targetKillIndex).toBeGreaterThan(-1);
    expect(targetKillIndex).toBeLessThan(targetWaitIndex);
    expect(targetWaitIndex).toBeLessThan(processCheckIndex);
    expect(processCheckIndex).toBeLessThan(traceFreezeIndex);
    expect(traceFreezeIndex).toBeLessThan(evidenceSealIndex);
    const unsupportedTarget = spawnSync("bash", [fileURLToPath(macOSCanaryScriptUrl), "--target", "windows-x64"], { encoding: "utf8" });
    expect(unsupportedTarget.status).toBe(2);
    expect(unsupportedTarget.stderr).toContain("Unsupported macOS canary target: windows-x64");
    const duplicateTarget = spawnSync("bash", [fileURLToPath(macOSCanaryScriptUrl), "--target", "macos-x64", "--target", "macos-arm64"], { encoding: "utf8" });
    expect(duplicateTarget.status).toBe(2);
    expect(duplicateTarget.stderr).toContain("--target may be specified only once.");
    const releaseRunbook = await readFile(new URL("../docs/desktop-release-operations.md", import.meta.url), "utf8");
    expect(releaseRunbook).toContain("repo:vishaltandale00@9222298/relayer-graphcomplete@1327816644:environment:desktop-production-windows");
    expect(releaseRunbook).not.toContain("subject: repo:vishaltandale00/relayer-graphcomplete:environment:desktop-production-windows");
    const releaseEnvironment = {
      RELAYER_DESKTOP_RELEASE: "1",
      RELAYER_DESKTOP_TARGET: "macos-arm64",
      RELAYER_DESKTOP_CHANNEL: "preview",
      RELAYER_DESKTOP_UPDATE_BASE_URL: DESKTOP_RELEASE.updateBaseUrl,
      RELAYER_DESKTOP_CANDIDATE_RUN_ID: "12345",
      RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: "2",
      RELAYER_DESKTOP_SIGN_IDENTITY: "Developer ID Application: VISHAL TANDALE (NZ253AL7U6)",
      APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
      APPLE_API_KEY_ID: "TESTKEY",
      APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
    };
    const sourceCommit = "a".repeat(40);
    const contract = resolveDesktopReleaseContract({
      environment: releaseEnvironment,
      version: "0.2.0",
      targetKey: "macos-arm64",
      sourceCommit,
    });
    expect(contract).toMatchObject({
      release: true,
      appId: "ai.relayer.desktop",
      version: "0.2.0",
      architecture: "arm64",
      minimumMacOSVersion: "13.3.0",
      minimumUpdateSystemVersion: "22.4.0",
      channelName: "preview",
      providerChannel: "beta",
      manifestName: "beta-mac.yml",
      sourceCommit,
      candidateWorkflowRunId: "12345",
      candidateWorkflowRunAttempt: "2",
      appleTeamId: "NZ253AL7U6",
    });
    const builder = createDesktopBuilderConfig(contract);
    expect(builder.dmg).toEqual({ sign: true });
    expect(builder).toMatchObject({
      appId: "ai.relayer.desktop",
      productName: "Relayer",
      forceCodeSigning: true,
      afterPack: "desktop/packaging/verify-bundled-app-server.mjs",
      afterSign: "desktop/release/verify-macos-app.mjs",
      mac: {
        identity: "VISHAL TANDALE (NZ253AL7U6)",
        minimumSystemVersion: "13.3.0",
        hardenedRuntime: true,
        notarize: true,
      },
      publish: [{ provider: "generic", url: DESKTOP_RELEASE.updateBaseUrl, channel: "beta" }],
    });
    // Electron 43's Squirrel.Mac implementation rejects valid numeric versions when
    // this native flag is enabled. Version monotonicity remains enforced by the
    // application updater above and by Preview publication.
    expect(builder.mac.extendInfo).toBeUndefined();
    expect(builder.extraResources).toContainEqual(expect.objectContaining({
      to: "harnesses/claude-basic.yaml",
    }));
    expect(builder.extraResources).toContainEqual(ladybugNoticesExtraResource(repositoryRoot));
    expect(builder.files).toEqual(expect.arrayContaining(
      Object.values(ACTIVE_PROVIDER_ADAPTER_MODULES).map((modulePath) => `main/${modulePath}`),
    ));

    const development = resolveDesktopReleaseContract({
      environment: { RELAYER_DESKTOP_TARGET: "macos-arm64" },
      version: "0.2.0",
    });
    expect(development).toMatchObject({
      release: false,
      appId: "ai.relayer.desktop.development",
      productName: "Relayer Dev",
      channelName: "development",
      signingMode: "unsigned",
      sourceCommit: null,
    });
    const isolatedTarget = createDesktopBuilderConfig(development, {
      environment: {
        RELAYER_DESKTOP_TARGET: "macos-arm64",
        RELAYER_CARGO_TARGET_DIR: "/tmp/isolated-cargo-target",
      },
      argv: ["--dir"],
    });
    expect(isolatedTarget.extraResources).toContainEqual({
      from: "/tmp/isolated-cargo-target/aarch64-apple-darwin/release/relayer-graph-server",
      to: "bin/relayer-graph-server",
    });
    expect(resolveDesktopReleaseContract({
      environment: { RELAYER_DESKTOP_TARGET: "macos-arm64" },
      version: "0.2.0",
      sourceCommit,
    }).sourceCommit).toBe(sourceCommit);

    const windowsEnvironment = {
      RELAYER_DESKTOP_RELEASE: "1",
      RELAYER_DESKTOP_TARGET: "windows-x64",
      RELAYER_DESKTOP_CHANNEL: "preview",
      RELAYER_DESKTOP_UPDATE_BASE_URL: DESKTOP_RELEASE_TARGETS["windows-x64"].updateBaseUrl,
      RELAYER_WINDOWS_SIGNING_ENDPOINT: DESKTOP_RELEASE.artifactSigningEndpoint,
      RELAYER_WINDOWS_SIGNING_ACCOUNT: DESKTOP_RELEASE.artifactSigningAccountName,
      RELAYER_WINDOWS_CERTIFICATE_PROFILE: "relayer-public-trust",
      RELAYER_WINDOWS_PUBLISHER_NAME: WINDOWS_PUBLISHER_DN,
    };
    const windowsContract = resolveDesktopReleaseContract({
      environment: windowsEnvironment,
      version: "0.2.0",
      sourceCommit,
    });
    expect(windowsContract).toMatchObject({
      targetKey: "windows-x64",
      platform: "win32",
      architecture: "x64",
      manifestName: "beta.yml",
      signingMode: "azure-artifact-signing",
      publisherName: WINDOWS_PUBLISHER_DN,
    });
    const windowsBuilder = createDesktopBuilderConfig(windowsContract);
    expect(windowsBuilder).toMatchObject({
      forceCodeSigning: true,
      afterSign: "desktop/release/verify-windows-app.mjs",
      win: {
        verifyUpdateCodeSignature: true,
        azureSignOptions: {
          endpoint: DESKTOP_RELEASE.artifactSigningEndpoint,
          codeSigningAccountName: DESKTOP_RELEASE.artifactSigningAccountName,
          certificateProfileName: "relayer-public-trust",
          publisherName: WINDOWS_PUBLISHER_DN,
        },
      },
      publish: [{
        provider: "generic",
        url: DESKTOP_RELEASE_TARGETS["windows-x64"].updateBaseUrl,
        channel: "beta",
      }],
    });
    expect(() => resolveDesktopReleaseContract({
      environment: { ...windowsEnvironment, RELAYER_WINDOWS_PUBLISHER_NAME: "Relayer Labs LLC" },
      version: "0.2.0",
      sourceCommit,
    })).toThrow("exact certificate distinguished name");

    const invalidCases = [
      [{ ...releaseEnvironment, RELAYER_DESKTOP_CHANNEL: "nightly" }, "0.2.0", sourceCommit, "stable or preview"],
      [releaseEnvironment, "0.1.0", sourceCommit, "0.2.0 or newer"],
      [{ ...releaseEnvironment, RELAYER_DESKTOP_UPDATE_BASE_URL: "https://example.test" }, "0.2.0", sourceCommit, "must be exactly"],
      [{ ...releaseEnvironment, RELAYER_DESKTOP_SIGN_IDENTITY: "Apple Development: Example" }, "0.2.0", sourceCommit, "Developer ID Application"],
      [{ ...releaseEnvironment, APPLE_API_KEY: "" }, "0.2.0", sourceCommit, "notarytool"],
      [{ ...releaseEnvironment, CSC_LINK: "/tmp/certificate.p12" }, "0.2.0", sourceCommit, "provided together"],
      [{ ...releaseEnvironment, RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: "" }, "0.2.0", sourceCommit, "run and attempt IDs together"],
      [releaseEnvironment, "0.2.0", "short", "40-character"],
    ];
    for (const [environment, version, commit, message] of invalidCases) {
      expect(() => resolveDesktopReleaseContract({ environment, version, sourceCommit: commit })).toThrow(message);
    }

    const directory = await mkdtemp(join(tmpdir(), "relayer-release-contract-"));
    try {
      const appPath = join(directory, "Relayer.app");
      const bundledBinary = join(appPath, "Contents", "Resources", "bin", "relayer-app-server");
      const bundledGraphBinary = join(appPath, "Contents", "Resources", "bin", "relayer-graph-server");
      const bundledGraphClient = join(appPath, "Contents", "Resources", "graph-client", "index.js");
      const bundledMarked = join(appPath, "Contents", "Resources", "renderer", "vendor", "marked.umd.js");
      const bundledCodexBrowserRoot = join(appPath, "Contents", "Resources", "app.asar.unpacked", "node_modules", "chrome-devtools-mcp");
      const bundledCodexBrowserScript = join(bundledCodexBrowserRoot, "build", "src", "bin", "chrome-devtools-mcp.js");
      await mkdir(join(appPath, "Contents", "Resources", "bin"), { recursive: true });
      await mkdir(join(appPath, "Contents", "Resources", "graph-client"), { recursive: true });
      await mkdir(join(appPath, "Contents", "Resources", "renderer", "vendor"), { recursive: true });
      await mkdir(join(bundledCodexBrowserRoot, "build", "src", "bin"), { recursive: true });
      await Promise.all([
        writeFile(bundledBinary, "binary-fixture"),
        writeFile(bundledGraphBinary, "binary-fixture"),
        writeFile(bundledGraphClient, "export class RelayerGraphClient { search() {} }\n"),
        writeFile(bundledMarked, "marked-fixture"),
        writeFile(join(bundledCodexBrowserRoot, "package.json"), `${JSON.stringify({ name: "chrome-devtools-mcp", version: "1.8.0" })}\n`),
        writeFile(bundledCodexBrowserScript, "helper-fixture"),
      ]);
      const packagedRuntimeEntries = () => [
        "main/single-instance.mjs",
        "main/services/codex-browser-mcp-runtime.mjs",
        "node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
        "node_modules/@relayer/graph-client/dist/index.js",
        "node_modules/@relayer/harness-host/dist/index.js",
        "node_modules/@relayer/harness-host/dist/implementations/claude-basic-browser.js",
        "node_modules/@relayer/eval-runner/dist/index.js",
      ];
      const verifyPrimeAgent = async () => ({ sourceCommit: "fixture", packages: 4 });
      const verifyGraphServer = async () => ({
        libraries: ["/usr/lib/libSystem.B.dylib"],
        state: "created",
      });
      const verifyNotices = async () => ({ notices: 29 });
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "arm64\n", stderr: "" }),
        expectedArchitecture: "arm64",
        listPackageEntries: packagedRuntimeEntries,
        verifyGraphServer,
        verifyPrimeAgent,
        verifyNotices,
      })).resolves.toEqual({ binaryPath: bundledBinary, architecture: "arm64" });
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "x86_64\n", stderr: "" }),
        expectedArchitecture: "x86_64",
        listPackageEntries: packagedRuntimeEntries,
        verifyGraphServer,
        verifyPrimeAgent,
        verifyNotices,
      })).resolves.toEqual({ binaryPath: bundledBinary, architecture: "x86_64" });
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "x86_64\n", stderr: "" }),
        expectedArchitecture: "arm64",
        listPackageEntries: packagedRuntimeEntries,
        verifyGraphServer,
        verifyPrimeAgent,
        verifyNotices,
      })).rejects.toThrow("must contain only arm64");
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "arm64\n", stderr: "" }),
        expectedArchitecture: "arm64",
        listPackageEntries: () => packagedRuntimeEntries().filter((entry) => entry !== "node_modules/@relayer/graph-client/dist/index.js"),
        verifyGraphServer,
        verifyPrimeAgent,
        verifyNotices,
      })).rejects.toThrow("missing node_modules/@relayer/graph-client/dist/index.js");
      await writeFile(bundledGraphClient, "export class RelayerGraphClient {}\n");
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "arm64\n", stderr: "" }),
        expectedArchitecture: "arm64",
        listPackageEntries: packagedRuntimeEntries,
        verifyGraphServer,
        verifyPrimeAgent,
        verifyNotices,
      })).rejects.toThrow("missing RelayerGraphClient.prototype.search");
      await writeFile(bundledGraphClient, "export class RelayerGraphClient { search() {} }\n");
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "arm64\n", stderr: "" }),
        expectedArchitecture: "arm64",
        listPackageEntries: () => packagedRuntimeEntries().filter((entry) => entry !== "node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"),
        verifyGraphServer,
        verifyPrimeAgent,
        verifyNotices,
      })).rejects.toThrow("missing node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js");
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "arm64\n", stderr: "" }),
        expectedArchitecture: "arm64",
        listPackageEntries: () => packagedRuntimeEntries().filter((entry) => entry !== "node_modules/@relayer/harness-host/dist/implementations/claude-basic-browser.js"),
        verifyGraphServer,
        verifyPrimeAgent,
        verifyNotices,
      })).rejects.toThrow("missing node_modules/@relayer/harness-host/dist/implementations/claude-basic-browser.js");
      await rm(bundledCodexBrowserScript);
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "arm64\n", stderr: "" }),
        expectedArchitecture: "arm64",
        listPackageEntries: packagedRuntimeEntries,
        verifyGraphServer,
        verifyPrimeAgent,
        verifyNotices,
      })).rejects.toThrow(/chrome-devtools-mcp\.js|ENOENT/);
      await writeFile(bundledCodexBrowserScript, "helper-fixture");
      await rm(bundledCodexBrowserScript);
      await mkdir(bundledCodexBrowserScript);
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "arm64\n", stderr: "" }),
        expectedArchitecture: "arm64",
        listPackageEntries: packagedRuntimeEntries,
        verifyGraphServer,
        verifyPrimeAgent,
        verifyNotices,
      })).rejects.toThrow("Bundled Codex browser helper files are invalid.");
      await rm(bundledCodexBrowserScript, { recursive: true });
      await writeFile(bundledCodexBrowserScript, "helper-fixture");
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "arm64\n", stderr: "" }),
        expectedArchitecture: "arm64",
        listPackageEntries: packagedRuntimeEntries,
        verifyGraphServer,
        verifyPrimeAgent: async () => { throw Object.assign(new Error("missing nested Prime asset"), { code: "ENOENT" }); },
        verifyNotices,
      })).rejects.toThrow("missing nested Prime asset");
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "arm64\n", stderr: "" }),
        expectedArchitecture: "arm64",
        listPackageEntries: packagedRuntimeEntries,
        verifyGraphServer,
        verifyPrimeAgent,
        verifyNotices: async () => { throw new Error("missing Ladybug notice"); },
      })).rejects.toThrow("missing Ladybug notice");

      // Let the default notice verifier run against the real vendored notices
      // copied into the fixture's resources layout, so the seam's default
      // inventory path and directory mapping are exercised rather than stubbed.
      await cp(
        join(repositoryRoot, "vendor", "ladybug", "notices"),
        join(appPath, "Contents", "Resources", "notices", "ladybug"),
        { recursive: true },
      );
      await expect(verifyBundledAppServer(appPath, {
        execute: async () => ({ stdout: "arm64\n", stderr: "" }),
        expectedArchitecture: "arm64",
        listPackageEntries: packagedRuntimeEntries,
        verifyGraphServer,
        verifyPrimeAgent,
      })).resolves.toEqual({ binaryPath: bundledBinary, architecture: "arm64" });

      const windowsPath = join(directory, "win-unpacked");
      await mkdir(join(windowsPath, "resources", "bin"), { recursive: true });
      await mkdir(join(windowsPath, "resources", "graph-client"), { recursive: true });
      await mkdir(join(windowsPath, "resources", "renderer", "vendor"), { recursive: true });
      const windowsCodexBrowserRoot = join(windowsPath, "resources", "app.asar.unpacked", "node_modules", "chrome-devtools-mcp");
      await mkdir(join(windowsCodexBrowserRoot, "build", "src", "bin"), { recursive: true });
      await Promise.all([
        writeFile(join(windowsPath, "resources", "bin", "relayer-app-server.exe"), "binary-fixture"),
        writeFile(join(windowsPath, "resources", "bin", "relayer-graph-server.exe"), "binary-fixture"),
        writeFile(join(windowsPath, "resources", "graph-client", "index.js"), "export class RelayerGraphClient { search() {} }\n"),
        writeFile(join(windowsPath, "resources", "renderer", "vendor", "marked.umd.js"), "marked-fixture"),
        writeFile(join(windowsCodexBrowserRoot, "package.json"), `${JSON.stringify({ name: "chrome-devtools-mcp", version: "1.8.0" })}\n`),
        writeFile(join(windowsCodexBrowserRoot, "build", "src", "bin", "chrome-devtools-mcp.js"), "helper-fixture"),
      ]);
      await expect(verifyBundledAppServer(windowsPath, {
        platform: "win32",
        execute: async () => { throw new Error("lipo must not run for Windows"); },
        listPackageEntries: () => packagedRuntimeEntries().map((entry) => `\\${entry.replaceAll("/", "\\")}`),
        verifyPrimeAgent: async (_resourcesPath, packagedEntries) => {
          expect(packagedEntries).toEqual(new Set(packagedRuntimeEntries()));
          return verifyPrimeAgent();
        },
        verifyNotices,
      })).resolves.toEqual({
        binaryPath: join(windowsPath, "resources", "bin", "relayer-app-server.exe"),
        architecture: null,
      });

      const noticeFixture = join(directory, "notice-fixture");
      await mkdir(join(noticeFixture, "notices", "ladybug", "third-party"), { recursive: true });
      const noticeBytes = Buffer.from("reviewed MIT notice bytes\n");
      const noticeDigest = createHash("sha256").update(noticeBytes).digest("hex");
      const noticeInventoryPath = join(directory, "notice-inventory.json");
      await writeFile(noticeInventoryPath, `${JSON.stringify({
        noticeSha256: {
          "vendor/ladybug/notices/ladybug-binding-LICENSE": noticeDigest,
          "vendor/ladybug/notices/third-party/alp-LICENSE": noticeDigest,
        },
      })}\n`);
      await writeFile(join(noticeFixture, "notices", "ladybug", "ladybug-binding-LICENSE"), noticeBytes);
      await writeFile(join(noticeFixture, "notices", "ladybug", "third-party", "alp-LICENSE"), noticeBytes);
      await expect(verifyPackagedLadybugNotices(noticeFixture, {
        inventoryPath: noticeInventoryPath,
      })).resolves.toEqual({ notices: 2 });
      await rm(join(noticeFixture, "notices", "ladybug", "third-party", "alp-LICENSE"));
      await expect(verifyPackagedLadybugNotices(noticeFixture, {
        inventoryPath: noticeInventoryPath,
      })).rejects.toThrow("missing the Ladybug notice third-party/alp-LICENSE");
      await writeFile(join(noticeFixture, "notices", "ladybug", "third-party", "alp-LICENSE"), "mutated bytes\n");
      await expect(verifyPackagedLadybugNotices(noticeFixture, {
        inventoryPath: noticeInventoryPath,
      })).rejects.toThrow("differs from the vendored digest");
      await writeFile(join(noticeFixture, "notices", "ladybug", "third-party", "alp-LICENSE"), noticeBytes);
      await writeFile(join(noticeFixture, "notices", "ladybug", "third-party", "stray-LICENSE"), "stray\n");
      await expect(verifyPackagedLadybugNotices(noticeFixture, {
        inventoryPath: noticeInventoryPath,
      })).rejects.toThrow("ships unlisted Ladybug notices");

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
        appPath,
        contract,
        distRoot: directory,
        execute: async (_command, args) => {
          await writeFile(args.at(-1), finalZip);
          return { stdout: "", stderr: "" };
        },
        createBlockMap: async ({ outputPath }) => writeFile(outputPath, "blockmap-fixture"),
      });
      const finalizedManifest = await readFile(join(directory, names.manifest), "utf8");
      expect(finalizedManifest).toContain("minimumSystemVersion: 22.4.0");
      const written = await writeDesktopReleaseEvidence({ distRoot: directory, contract });
      expect(written.receipt).toMatchObject({
        version: "0.2.0",
        channel: "preview",
        sourceCommit,
        target: "macos-arm64",
        signing: { appleTeamId: "NZ253AL7U6" },
      });
      expect(written.zip.sha512).toBe(createHash("sha512").update(finalZip).digest("base64"));
      await expect(verifyDesktopReleaseEvidence({ distRoot: directory, contract })).resolves.toMatchObject({
        names: { receipt: names.receipt, checksums: names.checksums },
      });
      await writeFile(
        join(directory, names.manifest),
        finalizedManifest.replace("minimumSystemVersion: 22.4.0", "minimumSystemVersion: 22.3.0"),
      );
      await expect(verifyDesktopReleaseEvidence({ distRoot: directory, contract }))
        .rejects.toThrow("minimum system version");
      await writeFile(join(directory, names.manifest), finalizedManifest);
      await writeFile(join(directory, names.checksums), "tampered\n");
      await expect(verifyDesktopReleaseEvidence({ distRoot: directory, contract })).rejects.toThrow("checksum manifest");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("pins one Node toolchain across CI and release workflows", async () => {
    // Node was declared in ten places across five workflows: ci.yml floated on
    // "22" while the release path pinned "22.22.0". Floating "22" is not even
    // self-consistent — one run resolved 22.23.1 on macOS and 22.23.2 on Linux,
    // because runner images carry different tool caches. .node-version is now
    // the only place the version is written; this test keeps it that way.
    const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
    // GitHub accepts .yaml as well as .yml. Matching only .yml would let a
    // workflow added under the other spelling skip this guard entirely, which
    // is precisely the case globbing the directory is meant to cover.
    const workflowNames = (await readdir(workflowDirectory)).filter((name) => /\.ya?ml$/.test(name));
    expect(workflowNames.length).toBeGreaterThan(0);

    const pinnedVersion = await readFile(new URL("../.node-version", import.meta.url), "utf8");
    // An exact patch version, not a floating major: setup-node resolves "22" to
    // whatever the runner happens to cache, which is how the drift started.
    expect(pinnedVersion).toMatch(/^\d+\.\d+\.\d+\n$/);

    // Parsed rather than string-matched. A line-anchored regex misses
    // `with: { node-version: 20 }`, and reports a mismatched step count instead
    // of naming the offending step — which is the wrong thing to hand someone
    // who has just reintroduced the bug this test exists to prevent.
    let setupNodeSteps = 0;
    for (const name of workflowNames) {
      const workflow = parseYaml(await readFile(new URL(name, workflowDirectory), "utf8"));
      for (const [jobName, job] of Object.entries(workflow?.jobs ?? {})) {
        for (const step of job?.steps ?? []) {
          if (!String(step?.uses ?? "").startsWith("actions/setup-node@")) continue;
          setupNodeSteps += 1;
          const where = `${name} → job "${jobName}" → ${step.uses}`;
          expect(step.with?.["node-version"], `${where} declares a literal node-version`).toBeUndefined();
          // Asserting the file is named, rather than only that no literal
          // exists, is what catches a step declaring no version at all and
          // silently inheriting whatever Node the runner preinstalled.
          expect(step.with?.["node-version-file"], `${where} must read .node-version`).toBe(".node-version");
        }
      }
    }

    // Deliberately not asserting a fixed count of ten. Removing a workflow is a
    // legitimate change — #305 may retire the Intel canary — and it must not
    // fail a test about Node pinning. Greater-than-zero only guards against the
    // glob silently matching nothing and the assertions above never running.
    expect(setupNodeSteps).toBeGreaterThan(0);
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
      schemaVersion: 2,
      product: "Relayer",
      appId: DESKTOP_RELEASE.productionAppId,
      version,
      target: "macos-arm64",
      platform: "macos",
      architecture: "arm64",
      minimumMacOSVersion: DESKTOP_RELEASE_TARGETS["macos-arm64"].minimumMacOSVersion,
      channel: "preview",
      manifest: "beta-mac.yml",
      updateBaseUrl: DESKTOP_RELEASE_TARGETS["macos-arm64"].updateBaseUrl,
      sourceCommit,
      candidateWorkflowRunId: "99",
      candidateWorkflowRunAttempt: "1",
      signing: {
        mode: "certificate-file",
        appleTeamId: DESKTOP_RELEASE.appleTeamId,
        notarizationMode: "app-store-connect-api-key",
      },
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
      RELAYER_DESKTOP_CANDIDATE_RUN_ID: "99",
      RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: "1",
      RELAYER_DESKTOP_CANDIDATE_ARTIFACT_ID: "777",
      RELAYER_DESKTOP_CANDIDATE_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
    }, version)).toEqual({
      sourceCommit,
      workflowRunId: "123",
      workflowRunAttempt: "2",
      candidateWorkflowRunId: "99",
      candidateWorkflowRunAttempt: "1",
      candidateArtifactId: "777",
      candidateArtifactDigest: `sha256:${"b".repeat(64)}`,
    });
    expect(() => validatePreviewPublicationProvenance({
      GITHUB_SHA: sourceCommit,
      GITHUB_REF_NAME: "desktop-v0.2.1",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
      RELAYER_DESKTOP_CANDIDATE_RUN_ID: "99",
      RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: "1",
      RELAYER_DESKTOP_CANDIDATE_ARTIFACT_ID: "777",
      RELAYER_DESKTOP_CANDIDATE_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
    }, version)).toThrow(`desktop-v${version}`);

    expect(() => validatePreviewCandidate({
      releaseReceipt,
      checksumText,
      version,
      sourceCommit,
      candidateWorkflowRunId: "99",
      candidateWorkflowRunAttempt: "1",
      artifactEvidence: evidence,
    })).not.toThrow();
    expect(() => validatePreviewCandidate({
      releaseReceipt,
      checksumText,
      version,
      sourceCommit,
      candidateWorkflowRunId: "99",
      candidateWorkflowRunAttempt: "2",
      artifactEvidence: evidence,
    })).toThrow("publication provenance");
    expect(() => validatePreviewCandidate({
      releaseReceipt,
      checksumText: checksumText.replace(dmg.sha256, "0".repeat(64)),
      version,
      sourceCommit,
      artifactEvidence: evidence,
    })).toThrow("checksum manifest");

    const manifestText = [
      `version: ${version}`,
      `minimumSystemVersion: ${DESKTOP_RELEASE.minimumUpdateSystemVersion}`,
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
    expect(preparedManifest).toContain(`minimumSystemVersion: ${DESKTOP_RELEASE.minimumUpdateSystemVersion}`);
    expect(() => preparePreviewManifest({
      manifestText: manifestText.replace(
        `minimumSystemVersion: ${DESKTOP_RELEASE.minimumUpdateSystemVersion}\n`,
        "minimumSystemVersion: 22.3.0\n",
      ),
      version,
      artifactEvidence: evidence,
    })).toThrow("minimum system version");
    expect(preparedManifest).toContain(`releases/${version}/${zip.name}`);
    expect(preparedManifest).toContain(`releases/${version}/${dmg.name}`);
    expect(preparedManifest).toContain("relayerManagedRuntimes:");
    expect(preparedManifest).toContain("codex: 0.147.0");
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
    expect(validateStablePromotionProvenance({
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: sourceCommit,
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_ACTOR: "release-operator",
      STABLE_PROMOTION_CONFIRMATION: `promote-macos-arm64-${version}`,
    }, version, "macos-arm64")).toEqual({
      workflowCommit: sourceCommit,
      workflowRunId: "456",
      workflowRunAttempt: "1",
      actor: "release-operator",
    });
    expect(() => validateStablePromotionProvenance({
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: sourceCommit,
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_ACTOR: "release-operator",
      STABLE_PROMOTION_CONFIRMATION: "promote-wrong-version",
    }, version, "macos-arm64")).toThrow(`promote-macos-arm64-${version}`);
    expect(classifyStablePointer({ version, manifestText: preparedManifest })).toEqual({ recovery: false });
    expect(classifyStablePointer({
      currentVersion: version,
      currentContent: preparedManifest,
      version,
      manifestText: preparedManifest,
    })).toEqual({ recovery: true });
    expect(() => classifyStablePointer({
      currentVersion: version,
      currentContent: "different bytes",
      version,
      manifestText: preparedManifest,
    })).toThrow("cannot be replaced");
  });

  it("seals and publishes the exact Windows x64 NSIS candidate", async () => {
    const version = "0.2.0";
    const sourceCommit = "c".repeat(40);
    const target = DESKTOP_RELEASE_TARGETS["windows-x64"];
    const contract = resolveDesktopReleaseContract({
      version,
      sourceCommit,
      environment: {
        RELAYER_DESKTOP_RELEASE: "1",
        RELAYER_DESKTOP_TARGET: target.key,
        RELAYER_DESKTOP_CHANNEL: "preview",
        RELAYER_DESKTOP_UPDATE_BASE_URL: target.updateBaseUrl,
        RELAYER_WINDOWS_SIGNING_ENDPOINT: DESKTOP_RELEASE.artifactSigningEndpoint,
        RELAYER_WINDOWS_SIGNING_ACCOUNT: DESKTOP_RELEASE.artifactSigningAccountName,
        RELAYER_WINDOWS_CERTIFICATE_PROFILE: "relayer-public-trust",
        RELAYER_WINDOWS_PUBLISHER_NAME: WINDOWS_PUBLISHER_DN,
      },
    });
    const directory = await mkdtemp(join(tmpdir(), "relayer-windows-release-"));
    try {
      const names = desktopReleaseArtifactNames(contract);
      const installer = Buffer.from("artifact-signing-nsis-fixture");
      const blockmap = Buffer.from("nsis-blockmap-fixture");
      const sha512 = createHash("sha512").update(installer).digest("base64");
      await Promise.all([
        writeFile(join(directory, names.installer), installer),
        writeFile(join(directory, `${names.installer}.blockmap`), blockmap),
        writeFile(join(directory, names.manifest), [
          `version: ${version}`,
          "files:",
          `  - url: ${names.installer}`,
          `    sha512: ${sha512}`,
          `    size: ${installer.length}`,
          `    blockMapSize: ${blockmap.length}`,
          `path: ${names.installer}`,
          `sha512: ${sha512}`,
          "",
        ].join("\n")),
      ]);

      const written = await writeDesktopReleaseEvidence({ distRoot: directory, contract });
      expect(written.receipt).toMatchObject({
        schemaVersion: 2,
        target: target.key,
        platform: "windows",
        architecture: "x64",
        manifest: "beta.yml",
        signing: {
          mode: "azure-artifact-signing",
          accountName: "relayercodesigning",
          certificateProfileName: "relayer-public-trust",
          publisherName: WINDOWS_PUBLISHER_DN,
        },
      });
      await expect(verifyDesktopReleaseEvidence({ distRoot: directory, contract })).resolves.toMatchObject({
        installer: expect.objectContaining({ name: names.installer, size: installer.length }),
      });

      const evidenceFor = async (name) => {
        const content = await readFile(join(directory, name));
        return {
          name,
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
          sha512: createHash("sha512").update(content).digest("base64"),
        };
      };
      const evidence = await Promise.all([
        names.installer,
        `${names.installer}.blockmap`,
        names.checksums,
        names.receipt,
      ].map(evidenceFor));
      expect(() => validatePreviewCandidate({
        releaseReceipt: written.receipt,
        checksumText: `${written.installer.sha256}  ${names.installer}\n`,
        version,
        sourceCommit,
        artifactEvidence: evidence,
        target,
      })).not.toThrow();
      const prepared = preparePreviewManifest({
        manifestText: await readFile(join(directory, names.manifest), "utf8"),
        version,
        artifactEvidence: evidence,
        target,
      });
      expect(prepared).toContain(`path: releases/${version}/${names.installer}`);
      expect(createPreviewPublicationPlan({ version, evidence, target })).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: names.installer,
          key: `desktop/windows/x64/releases/${version}/${names.installer}`,
        }),
      ]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
        schemaVersion: 2,
        product: DESKTOP_RELEASE.productName,
        appId: DESKTOP_RELEASE.productionAppId,
        version,
        target: "macos-arm64",
        platform: "macos",
        architecture: "arm64",
        minimumMacOSVersion: DESKTOP_RELEASE_TARGETS["macos-arm64"].minimumMacOSVersion,
        channel: "preview",
        manifest: "beta-mac.yml",
        updateBaseUrl: DESKTOP_RELEASE_TARGETS["macos-arm64"].updateBaseUrl,
        sourceCommit,
        candidateWorkflowRunId: "99",
        candidateWorkflowRunAttempt: "1",
        signing: {
          mode: "certificate-file",
          appleTeamId: DESKTOP_RELEASE.appleTeamId,
          notarizationMode: "app-store-connect-api-key",
        },
        artifacts: [dmg, zip],
      };
      contents.set(`${prefix}-SHA256SUMS.txt`, Buffer.from(checksumText));
      contents.set(`${prefix}-RELEASE.json`, Buffer.from(JSON.stringify(releaseReceipt)));
      await Promise.all([...contents].map(([name, content]) => writeFile(join(directory, name), content)));
      await writeFile(join(directory, "beta-mac.yml"), [
        `version: ${version}`,
        `minimumSystemVersion: ${DESKTOP_RELEASE.minimumUpdateSystemVersion}`,
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
      const releaseObjectPrefix = `desktop/macos/arm64/releases/${version}`;
      let deniedPutKey = `${releaseObjectPrefix}/${dmg.name}`;
      const raceOnceKey = `${releaseObjectPrefix}/${dmgBlockmap.name}`;
      const stableHistoryKey = `private/history/macos-arm64/latest/${version}/latest-mac.yml`;
      const conflictOnceKeys = new Set([`${releaseObjectPrefix}/${zipBlockmap.name}`, stableHistoryKey]);
      const conditionalConflicts = new Set();
      const conditionalRaces = new Set();
      const argument = (args, name) => args[args.indexOf(name) + 1];
      const objectFromPut = async (args) => {
        const body = await readFile(argument(args, "--body"));
        return {
          body,
          metadata: Object.fromEntries(argument(args, "--metadata").split(",").map((item) => item.split("="))),
          checksumSha256: argument(args, "--checksum-sha256"),
          etag: `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`,
        };
      };
      const execute = async (command, args) => {
        expect(command).toBe("aws");
        const operation = args[1];
        const key = argument(args, "--key");
        if (operation === "head-object") {
          const object = objects.get(key);
          if (!object) {
            const error = new Error("Forbidden");
            error.stderr = "An error occurred (403) when calling the HeadObject operation: Forbidden";
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
        if (key === deniedPutKey) {
          const error = new Error("AccessDenied");
          error.stderr = "An error occurred (AccessDenied) when calling the PutObject operation: 403 Forbidden";
          throw error;
        }
        const existing = objects.get(key);
        if (args.includes("--if-none-match") && key === raceOnceKey && !conditionalRaces.has(key)) {
          objects.set(key, await objectFromPut(args));
          conditionalRaces.add(key);
          throw new Error("PreconditionFailed 412");
        }
        if (args.includes("--if-none-match") && existing) throw new Error("PreconditionFailed");
        if (args.includes("--if-none-match") && conflictOnceKeys.has(key) && !conditionalConflicts.has(key)) {
          conditionalConflicts.add(key);
          throw new Error("ConditionalRequestConflict 409");
        }
        if (args.includes("--if-match") && existing?.etag !== argument(args, "--if-match")) {
          throw new Error("PreconditionFailed");
        }
        const object = await objectFromPut(args);
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
        RELAYER_DESKTOP_CANDIDATE_RUN_ID: "99",
        RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT: "1",
        RELAYER_DESKTOP_CANDIDATE_ARTIFACT_ID: "777",
        RELAYER_DESKTOP_CANDIDATE_ARTIFACT_DIGEST: `sha256:${"b".repeat(64)}`,
      };
      const pointerKey = "desktop/macos/arm64/beta-mac.yml";
      const historyKey = `private/history/macos-arm64/beta/${version}/beta-mac.yml`;
      const receiptKey = `private/receipts/macos-arm64/preview/${version}.json`;

      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment,
        execute,
        fetchImpl,
      })).rejects.toThrow("AccessDenied");
      expect(objects.has(pointerKey)).toBe(false);
      deniedPutKey = null;

      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment,
        execute,
        fetchImpl,
      })).rejects.toThrow("Public update object is unavailable");
      expect(objects.has(pointerKey)).toBe(false);
      expect(objects.has(receiptKey)).toBe(false);
      expect(conditionalRaces.has(raceOnceKey)).toBe(true);
      expect(conditionalConflicts.has(`${releaseObjectPrefix}/${zipBlockmap.name}`)).toBe(true);

      failPublicArtifact = false;
      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment,
        execute,
        fetchImpl,
      })).resolves.toMatchObject({
        receipt: {
          version,
          sourceCommit,
          candidateWorkflowRunId: "99",
          candidateWorkflowRunAttempt: "1",
          candidateArtifactId: "777",
          candidateArtifactDigest: `sha256:${"b".repeat(64)}`,
          workflowRunId: "123",
        },
      });
      const releaseWriteIndexes = writes
        .map((key, index) => key.startsWith(`desktop/macos/arm64/releases/${version}/`) ? index : -1)
        .filter((index) => index >= 0);
      expect(writes.indexOf(pointerKey)).toBeGreaterThan(Math.max(...releaseWriteIndexes));
      expect(writes.indexOf(pointerKey)).toBeGreaterThan(writes.indexOf(historyKey));
      expect(writes.indexOf(receiptKey)).toBeGreaterThan(writes.indexOf(pointerKey));

      objects.delete(pointerKey);
      const writesBeforeMismatchedRecovery = [...writes];
      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment: { ...environment, RELAYER_DESKTOP_CANDIDATE_ARTIFACT_ID: "778" },
        execute,
        fetchImpl,
      })).rejects.toThrow("already has a different publication receipt");
      expect(objects.has(pointerKey)).toBe(false);
      expect(writes).toEqual(writesBeforeMismatchedRecovery);

      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment,
        execute,
        fetchImpl,
      })).resolves.toMatchObject({ receipt: { candidateArtifactId: "777" } });
      expect(objects.has(pointerKey)).toBe(true);

      const writesAfterSuccess = [...writes];
      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment: { ...environment, GITHUB_RUN_ATTEMPT: "2" },
        execute,
        fetchImpl,
      })).resolves.toMatchObject({ receipt: { workflowRunAttempt: "1" } });
      expect(writes).toEqual(writesAfterSuccess);

      const screenshotFixtures = Object.fromEntries(["first-install", "available", "ready", "installed"].map((name) => [
        name,
        { file: `${name}.png`, content: Buffer.from(`signed-app-${name}-screenshot`) },
      ]));
      const canaryTraceName = "signed-preview-canary.jsonl";
      const canaryTrace = [
        { schemaVersion: 1, capturedAt: "2026-08-18T20:00:00.000Z", target: "macos-arm64", platform: "darwin", architecture: "arm64", processId: 100, state: { phase: "idle", version: "0.2.2", channel: "preview", error: null } },
        { schemaVersion: 1, capturedAt: "2026-08-18T20:00:01.000Z", target: "macos-arm64", platform: "darwin", architecture: "arm64", processId: 100, state: { phase: "available", version: "0.2.2", availableVersion: version, channel: "preview", error: null } },
        { schemaVersion: 1, capturedAt: "2026-08-18T20:00:02.000Z", target: "macos-arm64", platform: "darwin", architecture: "arm64", processId: 100, state: { phase: "downloading", version: "0.2.2", availableVersion: version, channel: "preview", percent: 35, error: null } },
        { schemaVersion: 1, capturedAt: "2026-08-18T20:00:03.000Z", target: "macos-arm64", platform: "darwin", architecture: "arm64", processId: 100, state: { phase: "ready", version: "0.2.2", availableVersion: version, channel: "preview", error: null } },
        { schemaVersion: 1, capturedAt: "2026-08-18T20:00:04.000Z", target: "macos-arm64", platform: "darwin", architecture: "arm64", processId: 200, state: { phase: "idle", version, channel: "preview", error: null } },
      ].map(JSON.stringify).join("\n");
      await Promise.all([
        ...Object.values(screenshotFixtures).map(({ file, content }) => writeFile(join(directory, file), content)),
        writeFile(join(directory, canaryTraceName), canaryTrace),
      ]);
      const canaryEvidenceName = "signed-preview-canary.json";
      await writeFile(join(directory, canaryEvidenceName), JSON.stringify({
        schemaVersion: 2,
        capturedAt: "2026-08-18T20:00:05.000Z",
        environment: { host: "test-mac", target: "macos-arm64", architecture: "arm64", os: "macOS 15.6" },
        seed: { version: "0.2.2", sourceCommit: "e".repeat(40), processId: 100 },
        target: {
          version,
          sourceCommit,
          workflowRunId: "123",
          artifactSha256: {
            [dmg.name]: dmg.sha256,
            [zip.name]: zip.sha256,
          },
        },
        productFlow: [
          { phase: "idle", version: "0.2.2", channel: "preview", error: null },
          { phase: "available", version: "0.2.2", availableVersion: version, channel: "preview", error: null },
          { phase: "downloading", version: "0.2.2", availableVersion: version, channel: "preview", displayedPercentages: [35], error: null },
          { phase: "ready", version: "0.2.2", availableVersion: version, channel: "preview", error: null },
          { phase: "installed-and-relaunched", version, channel: "preview", error: null },
        ],
        trace: {
          file: canaryTraceName,
          sha256: createHash("sha256").update(canaryTrace).digest("hex"),
          records: 5,
        },
        postUpdate: {
          installedVersion: version,
          running: true,
          codeSignatureVerified: true,
          platformAcceptanceVerified: true,
          processId: 200,
          channel: "preview",
          updateStatus: "idle",
        },
        screenshots: Object.fromEntries(Object.entries(screenshotFixtures).map(([name, { file, content }]) => [
          name === "first-install" ? "firstInstall" : name,
          { file, sha256: createHash("sha256").update(content).digest("hex") },
        ])),
      }));
      const validCanaryEvidence = JSON.parse(await readFile(join(directory, canaryEvidenceName), "utf8"));
      const duplicateCanaryEvidence = structuredClone(validCanaryEvidence);
      duplicateCanaryEvidence.screenshots.ready = { ...duplicateCanaryEvidence.screenshots.available };
      await writeFile(join(directory, canaryEvidenceName), JSON.stringify(duplicateCanaryEvidence));
      const previewReceipt = JSON.parse(objects.get(receiptKey).body.toString("utf8"));
      await expect(validateCanaryEvidenceFile({
        filePath: join(directory, canaryEvidenceName),
        version,
        previewReceipt,
      })).rejects.toThrow("Stable promotion requires visually distinct available, ready, and installed screenshots.");
      await writeFile(join(directory, canaryEvidenceName), JSON.stringify(validCanaryEvidence));
      const stableEnvironment = {
        GITHUB_REF: "refs/heads/main",
        GITHUB_SHA: "d".repeat(40),
        GITHUB_RUN_ID: "456",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_ACTOR: "release-operator",
        STABLE_PROMOTION_CONFIRMATION: `promote-macos-arm64-${version}`,
      };
      await expect(promoteDesktopStable({
        bucket: "updates",
        version,
        canaryEvidencePath: canaryEvidenceName,
        repositoryRoot: directory,
        environment: stableEnvironment,
        execute,
        fetchImpl,
      })).resolves.toMatchObject({
        receipt: {
          channel: "stable",
          version,
          sourceCommit,
          previewReceipt: { key: receiptKey },
          canaryEvidence: { repositoryPath: canaryEvidenceName },
        },
      });
      const stablePointerKey = "desktop/macos/arm64/latest-mac.yml";
      const stableReceiptKey = `private/receipts/macos-arm64/stable/${version}.json`;
      expect(objects.get(stablePointerKey).body).toEqual(objects.get(pointerKey).body);
      expect(writes.indexOf(stablePointerKey)).toBeGreaterThan(writes.indexOf(stableHistoryKey));
      expect(writes.indexOf(stableReceiptKey)).toBeGreaterThan(writes.indexOf(stablePointerKey));
      expect(conditionalConflicts.has(stableHistoryKey)).toBe(true);

      await writeFile(join(directory, canaryTraceName), `${canaryTrace}\n{}`);
      await expect(promoteDesktopStable({
        bucket: "updates",
        version,
        canaryEvidencePath: canaryEvidenceName,
        repositoryRoot: directory,
        environment: { ...stableEnvironment, GITHUB_RUN_ID: "457", GITHUB_RUN_ATTEMPT: "2" },
        execute,
        fetchImpl,
      })).rejects.toThrow("trace bytes do not match");
      await writeFile(join(directory, canaryTraceName), canaryTrace);

      const writesAfterPromotion = [...writes];
      await expect(promoteDesktopStable({
        bucket: "updates",
        version,
        canaryEvidencePath: canaryEvidenceName,
        repositoryRoot: directory,
        environment: { ...stableEnvironment, GITHUB_RUN_ID: "457", GITHUB_RUN_ATTEMPT: "2" },
        execute,
        fetchImpl,
      })).resolves.toMatchObject({ receipt: { promotion: { workflowRunId: "456" } } });
      expect(writes).toEqual(writesAfterPromotion);

      objects.get(`desktop/macos/arm64/releases/${version}/${zip.name}`).metadata.sha256 = "0".repeat(64);
      await expect(publishDesktopPreview({
        bucket: "updates",
        distRoot: directory,
        environment: { ...environment, GITHUB_RUN_ATTEMPT: "3" },
        execute,
        fetchImpl,
      })).rejects.toThrow("already exists with different evidence");
      expect(writes).toEqual(writesAfterPromotion);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps settings writes atomic and local thread graph state scoped to its owning thread", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-desktop-test-"));
    try {
      const settings = createSettingsStore(directory);
      let releaseMutation;
      let mutationStarted;
      const mutationGate = new Promise((resolveGate) => { releaseMutation = resolveGate; });
      const started = new Promise((resolveStarted) => { mutationStarted = resolveStarted; });
      const pendingWrite = settings.update(async () => {
        mutationStarted();
        await mutationGate;
        return { appearance: "light", updateChannel: "preview" };
      });
      await started;
      let flushed = false;
      const pendingFlush = settings.flush().then(() => { flushed = true; });
      await Promise.resolve();
      expect(flushed).toBe(false);
      releaseMutation();
      await pendingFlush;
      expect(flushed).toBe(true);
      await pendingWrite;
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
      state.visibleLayer = { nodes: [{ id: "durable-current" }] };
      expect(responseNodesForThread(state, first).map((node) => node.id)).toEqual(["durable-current"]);
      state.visibleLayer = null;
      state.status = "accepted";
      expect(responseNodesForThread(state, first).map((node) => node.id)).toEqual(["response"]);
      expect(responseNodesForThread(state, second)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses one product workspace implementation for interactive and eval-review contexts", async () => {
    const productAdapter = await readFile(new URL("../desktop/renderer/src/graph.js", import.meta.url), "utf8");
    const workspace = await readFile(new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url), "utf8");
    const productShell = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");

    expect(productAdapter).toContain("createProductWorkspace");
    expect(productAdapter).not.toContain("function physicsStep");
    expect(workspace).not.toContain("function physicsStep");
    expect(workspace).toContain("element.dataset.canonicalWorldX");
    expect(workspace).toContain("element.dataset.layoutSource");
    expect(productShell).toContain('<section class="thread-view hidden" id="threadView"></section>');
    expect(productShell).not.toContain('id="graphStage"');
    expect(productWorkspaceMarkup()).toContain('id="graphStage"');
    expect(productWorkspaceMarkup()).toContain('id="closeInspector"');
    expect(productWorkspaceMarkup()).toContain('id="conversationSettingsButton"');
    expect(productWorkspaceMarkup()).toContain('aria-label="Conversation settings"');
    expect(productWorkspaceMarkup()).not.toContain('id="runState"');
    expect(productWorkspaceMarkup()).toContain('id="exportConversation"');
    expect(productWorkspaceMarkup()).toContain('role="menuitem"');
    expect(productWorkspaceMarkup()).toContain('data-review-ref="export-conversation"');
    expect(workspaceModeCapabilities("interactive")).toEqual({
      canNavigate: true,
      canCompose: true,
      canInvokeMutatingActions: true,
      canExportConversation: true,
      canResolveApprovals: true,
    });
    expect(workspaceModeCapabilities("review")).toEqual({
      canNavigate: true,
      canCompose: false,
      canInvokeMutatingActions: false,
      canExportConversation: false,
      canResolveApprovals: false,
    });
    expect(() => workspaceModeCapabilities("comparison")).toThrow("Unknown product workspace mode");
  });

  it("anchors graph edges at icon boundaries and preserves dragged node positions", async () => {
    expect(graphEdgeSegment({ x: 10, y: 20 }, { x: 110, y: 20 }, 24)).toEqual({
      x1: 34,
      y1: 20,
      x2: 86,
      y2: 20,
    });

    const workspace = await readFile(new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url), "utf8");
    const styles = await readFile(new URL("../desktop/renderer/styles.css", import.meta.url), "utf8");
    expect(workspace).toContain("dragging.node.pinned = true");
    expect(workspace).toContain("cachedLayoutMatches && prior?.pinned");
    expect(styles).toContain("flex-direction:column");
    expect(styles).toContain("width:46px;height:46px");
  });

  it("renders node details as restricted Markdown without exposing internal kinds on graph cards", async () => {
    const html = await readFile(new URL("../desktop/renderer/index.html", import.meta.url), "utf8");
    const workspace = await readFile(new URL("../desktop/renderer/src/product-workspace/workspace.js", import.meta.url), "utf8");
    const markdown = await readFile(new URL("../desktop/renderer/src/product-workspace/markdown.js", import.meta.url), "utf8");

    expect(html).toContain('<script src="./vendor/marked.umd.js"></script>');
    expect(workspace).toContain('renderMarkdown($("#detailContent")');
    expect(workspace).not.toContain('<small>${escapeHtml(node.kind)}</small>');
    expect(markdown).toContain("ALLOWED_MARKDOWN_ELEMENTS");
    expect(markdown).toContain("DANGEROUS_MARKDOWN_ELEMENTS");
    expect(isSafeMarkdownLink("https://relayerlabs.ai/docs")).toBe(true);
    expect(isSafeMarkdownLink("http://127.0.0.1:3000/help")).toBe(true);
    expect(isSafeMarkdownLink("javascript:alert(1)")).toBe(false);
    expect(isSafeMarkdownLink("data:text/html,bad")).toBe(false);
  });
});
