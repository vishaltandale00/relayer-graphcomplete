import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from "electron";
import electronUpdater from "electron-updater";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import {
  productionProviderAdapterRegistry,
  productionProviderRuntimeDependencies,
  resolveLegacyCodexHome,
} from "./providers/provider-adapter-registry.mjs";
import { createProviderComposition } from "./providers/provider-composition.mjs";
import { createProviderDiagnosticsLog } from "./providers/provider-diagnostics-log.mjs";
import { createProviderRuntimeStateRemover } from "./providers/provider-runtime-state.mjs";
import {
  createEncryptedCredentialStore,
} from "./providers/provider-definition-store.mjs";
import { registerDesktopIpc } from "./ipc/register-ipc.mjs";
import { createConversationExportService } from "./services/conversation-export.mjs";
import { inspectCodexBrowserMcpRuntime } from "./services/codex-browser-mcp-runtime.mjs";
import { RelayerAppServerService } from "./services/relayer-app-server.mjs";
import { createCanaryEvidenceLog } from "./services/canary-evidence-log.mjs";
import { GraphCompleteRuntimeService, developerTemporalFeatures } from "./services/graphcomplete-runtime.mjs";
import { inspectPrimeAgentRuntime, requirePrimeAgentRuntime } from "./services/prime-agent-runtime.mjs";
import { resolveDesktopHarnessConfiguration } from "./services/desktop-harness-configuration.mjs";
import { createSettingsStore } from "./services/settings-store.mjs";
import { createTutorialLifecycle } from "./services/tutorial-lifecycle.mjs";
import {
  createDesktopAccountService,
  GRAPHCOMPLETE_AUTH0,
  GRAPHCOMPLETE_LOGIN_URL,
} from "./services/desktop-account-service.mjs";
import { createDesktopUpdater, resolveUpdateChannel } from "./services/updater.mjs";
import { createManagedRuntimeInstaller } from "./managed-runtimes/installer.mjs";
import { createManagedRuntimeResolver } from "./managed-runtimes/resolver.mjs";
import { confirmManagedRuntimeQuit } from "./managed-runtimes/quit-guard.mjs";
import { claimPrimaryDesktopInstance } from "./single-instance.mjs";
import { createWindowFactory } from "./window.mjs";
import {
  DESKTOP_UPDATE_BASE_URL,
  packagedDesktopReleaseMetadata,
} from "../shared/release-metadata.mjs";
import { nativeBinaryName } from "../shared/target.mjs";
import {
  activeProviderRuntimeRequirements,
  compatibleHarnessImplementationForAdapter,
  managedRuntimeRequirementForHarness,
  parseUpdateRuntimeRequirements,
} from "../shared/managed-runtime-requirements.mjs";

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopDirectory, "..");
if (process.env.RELAYER_DESKTOP_USER_DATA_DIR) {
  app.setPath("userData", resolve(process.env.RELAYER_DESKTOP_USER_DATA_DIR));
}

const metadataPath = app.isPackaged ? join(app.getAppPath(), "package.json") : join(repositoryRoot, "package.json");
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
const packagedRelease = packagedDesktopReleaseMetadata(metadata);
const releaseArtifact = packagedRelease !== null;
app.setName(metadata.relayerProductName || "Relayer Dev");

const userDataPath = app.getPath("userData");
const providerRuntimeRoot = join(userDataPath, "provider-runtimes");
const managedRuntimeInstaller = createManagedRuntimeInstaller({
  root: join(userDataPath, "managed-runtimes"),
});
const managedRuntimeResolver = createManagedRuntimeResolver(managedRuntimeInstaller);
const legacyCodexHome = resolveLegacyCodexHome(userDataPath, process.env);
const updateBaseUrl = packagedRelease?.updateBaseUrl || (
  app.isPackaged ? null : process.env.RELAYER_DESKTOP_UPDATE_BASE_URL || DESKTOP_UPDATE_BASE_URL
);
const relayerAppServerBinary = app.isPackaged
  ? join(process.resourcesPath, "bin", nativeBinaryName("relayer-app-server"))
  : resolve(process.env.RELAYER_APP_SERVER_BINARY || join(repositoryRoot, "target", "debug", "relayer-app-server"));
const relayerGraphServerBinary = app.isPackaged
  ? join(process.resourcesPath, "bin", nativeBinaryName("relayer-graph-server"))
  : resolve(process.env.RELAYER_GRAPH_SERVER_BIN || join(repositoryRoot, "target", "debug", "relayer-graph-server"));
const harnessDirectory = app.isPackaged
  ? join(process.resourcesPath, "harnesses")
  : join(repositoryRoot, "harnesses");
const permissionCatalogPath = app.isPackaged
  ? join(process.resourcesPath, "permissions", "desktop.json")
  : join(repositoryRoot, "permissions", "desktop.json");
const graphClientModuleUrl = app.isPackaged
  ? pathToFileURL(join(process.resourcesPath, "graph-client", "index.js")).href
  : undefined;
const codexBrowserMcpInspection = await inspectCodexBrowserMcpRuntime({
  executable: process.execPath,
  packageRoot: app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "node_modules", "chrome-devtools-mcp")
    : join(repositoryRoot, "node_modules", "chrome-devtools-mcp"),
});
if (!codexBrowserMcpInspection.available) {
  console.error("Codex browser helper unavailable", {
    code: codexBrowserMcpInspection.code,
    message: codexBrowserMcpInspection.message,
    diagnostics: codexBrowserMcpInspection.diagnostics,
  });
}
const primePythonClientRoot = app.isPackaged
  ? join(process.resourcesPath, "python", "relayer-graph", "src")
  : join(repositoryRoot, "python", "relayer-graph", "src");
process.env.RELAYER_PRIME_PYTHON_CLIENT_ROOT = primePythonClientRoot;
const primeAgentRuntime = await inspectPrimeAgentRuntime({
  appPath: app.isPackaged ? app.getAppPath() : repositoryRoot,
  harnessDirectory,
  manifestPath: app.isPackaged
    ? join(process.resourcesPath, "prime-agent", "manifest.json")
    : join(repositoryRoot, "vendor", "prime-agent", "manifest.json"),
  pythonClientRoot: primePythonClientRoot,
  platform: process.platform,
  defaultPermissionProfileId: "auto",
  integrityPhase: releaseArtifact && process.platform === "darwin" ? "signed" : "unsigned",
});
if (!primeAgentRuntime.available) {
  delete process.env.RELAYER_PRIME_RUNTIME_PROVENANCE;
  console.error("Prime Agent runtime unavailable", {
    code: primeAgentRuntime.code,
    message: primeAgentRuntime.message,
    diagnostics: primeAgentRuntime.diagnostics,
  });
} else process.env.RELAYER_PRIME_RUNTIME_PROVENANCE = JSON.stringify(primeAgentRuntime.diagnostics);
const rendererDirectory = app.isPackaged
  ? join(process.resourcesPath, "renderer")
  : join(desktopDirectory, "renderer");
const defaultHarnessConfiguration = resolveDesktopHarnessConfiguration({
  isPackaged: app.isPackaged,
  environment: process.env,
});
if (defaultHarnessConfiguration.startsWith("prime-agent-")) requirePrimeAgentRuntime(primeAgentRuntime);

let mainWindow;
const primaryInstance = claimPrimaryDesktopInstance({ app, getWindow: () => mainWindow });

if (primaryInstance) {
  let appearance = "dark";
  const settings = createSettingsStore(userDataPath);
  const tutorial = createTutorialLifecycle({ settings });
  let fatalShutdownRequested = false;
  const requestFatalShutdown = () => {
    fatalShutdownRequested = true;
    app.quit();
  };
  const graphRuntime = new GraphCompleteRuntimeService({
    userDataDirectory: userDataPath,
    graphServerBinary: relayerGraphServerBinary,
    configurationPaths: [...new Set([
      defaultHarnessConfiguration,
      "codex-basic",
      "claude-basic",
      ...(primeAgentRuntime.available ? primeAgentRuntime.configurationNames : []),
    ])].map((name) => join(harnessDirectory, `${name}.yaml`)),
    unavailableConfigurations: primeAgentRuntime.available ? [] : ["prime-agent-basic", "prime-agent-deep"].map((name) => ({
      name,
      reason: { code: primeAgentRuntime.code, message: primeAgentRuntime.message },
      diagnostics: primeAgentRuntime.diagnostics,
    })),
    codexBasicClientModuleUrl: graphClientModuleUrl,
    temporalFeatures: developerTemporalFeatures(),
    ...(codexBrowserMcpInspection.available ? { codexBrowserMcpRuntime: codexBrowserMcpInspection } : {}),
    acquireProviderExecution: (providerId) => {
      if (!providerSetup) throw new Error("Provider execution broker is not ready.");
      return providerSetup.acquireExecution(providerId);
    },
    onUnexpectedStop: () => {
      dialog.showErrorBox(
        "Relayer graph service stopped",
        "Relayer needs to close because its local graph service stopped. Reopen the app to continue.",
      );
      requestFatalShutdown();
    },
  });
  let productServer;
  let modelCatalog;
  let providerSetup;
  let providerComposition;
  const accountService = createDesktopAccountService({
    channel: "stable",
    credentialPath: join(userDataPath, "account-credentials.json"),
    auth0: GRAPHCOMPLETE_AUTH0,
    launcherUrl: GRAPHCOMPLETE_LOGIN_URL,
    encrypt: async (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Operating-system credential encryption is unavailable.");
      return safeStorage.encryptString(value).toString("base64");
    },
    decrypt: async (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("Operating-system credential encryption is unavailable.");
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    },
    openExternal: (url) => shell.openExternal(url),
    emit: (state) => mainWindow?.webContents.send("relayer:account-changed", state),
  });

  const managedRuntimeDescriptor = (runtime) => Object.freeze({
    runtimeId: runtime.runtimeId,
    version: runtime.version,
    executable: runtime.executable,
    ...(runtime.modulePath ? { moduleUrl: pathToFileURL(runtime.modulePath).href } : {}),
  });

  const canaryEvidenceLog = createCanaryEvidenceLog({
    appIsPackaged: app.isPackaged,
    releaseMetadata: packagedRelease,
  });
  const providerDiagnostics = createProviderDiagnosticsLog({
    path: join(userDataPath, "logs", "providers.jsonl"),
  });

  const updater = createDesktopUpdater({
    autoUpdater: electronUpdater.autoUpdater,
    app: {
      get isPackaged() { return app.isPackaged && releaseArtifact; },
      getVersion: () => app.getVersion(),
    },
    updateBaseUrl,
    prefetchRuntimeUpdate: async (info) => {
      if (!providerSetup) return;
      const incoming = parseUpdateRuntimeRequirements(info);
      const requirements = activeProviderRuntimeRequirements(await providerSetup.list())
        .map(({ runtimeId }) => ({ runtimeId, minimumVersion: incoming[runtimeId] }));
      if (requirements.length === 0) return;
      const result = await managedRuntimeInstaller.stageForAppUpdate(info.version, requirements);
      if (result.failures.length) {
        throw new AggregateError(
          result.failures.map(({ error }) => error),
          "One or more managed runtimes could not be prefetched for the app update.",
        );
      }
    },
    onRuntimePrefetchFailure: (error) => console.error("Managed runtime update prefetch failed:", error),
    emit: (state) => {
      void canaryEvidenceLog.write(state).catch((error) => console.error("Canary evidence log failed:", error));
      mainWindow?.webContents.send("relayer:update-changed", state);
    },
  });
  void canaryEvidenceLog.write(updater.status()).catch((error) => console.error("Canary evidence log failed:", error));

  const createWindow = createWindowFactory({
    BrowserWindow,
    desktopDirectory,
    getAppearance: () => appearance,
    updater,
  });

  let shutdownPromise;
  let shutdownComplete = false;
  let quitFlowPromise;

  const confirmQuit = ({ fatal = false } = {}) => confirmManagedRuntimeQuit({
    installer: managedRuntimeInstaller,
    dialog,
    parent: mainWindow,
    fatal,
    ...(fatal ? { reason: new Error("Relayer is closing after a fatal service failure.") } : {}),
  });

  async function shutdownServices() {
    shutdownPromise ??= (async () => {
      const results = [];
      try {
        if (productServer) await productServer.close();
      } catch (error) {
        results.push({ status: "rejected", reason: error });
      }
      results.push(...await Promise.allSettled([
        accountService.close(),
        providerComposition?.close(),
        graphRuntime.close(),
      ]));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        throw new AggregateError(failures.map((result) => result.reason), "Relayer services did not all stop cleanly.");
      }
    })();
    await shutdownPromise;
  }

  app.whenReady().then(async () => {
    const saved = await settings.read();
    appearance = saved.appearance === "light" ? "light" : "dark";
    nativeTheme.themeSource = appearance;
    const channel = resolveUpdateChannel(saved.updateChannel);
    if (channel === "preview") updater.setChannel("preview");
    await accountService.setChannel(channel);
    void accountService.start().catch((error) => console.error("Optional desktop account initialization failed:", error));
    const activation = await managedRuntimeInstaller.activatePendingAppUpdate(app.getVersion());
    if (activation.failures.length) {
      console.error("Managed runtime update activation failed:", new AggregateError(
        activation.failures.map(({ error }) => error),
        "One or more managed runtimes could not be activated after the app update.",
      ));
    }
    // Previous generations may have been leased by provider adapters until the
    // prior process exited. Prune them locally before creating new adapters.
    const pruning = await managedRuntimeInstaller.pruneInactiveInstallations();
    if (pruning.failures.length) {
      console.error("Retired managed runtime cleanup failed:", new AggregateError(
        pruning.failures.map(({ error }) => error),
        "One or more retired managed runtimes could not be removed.",
      ));
    }
    const runtimeSession = await graphRuntime.start();
    productServer = new RelayerAppServerService({
      userDataDirectory: userDataPath,
      binaryPath: relayerAppServerBinary,
      webDirectory: rendererDirectory,
      permissionCatalogPath,
      runtimeSession,
      defaultHarnessConfiguration,
      allowHarnessOverride: !app.isPackaged && defaultHarnessConfiguration.startsWith("prime-agent-"),
      exportProducer: {
        desktopVersion: app.getVersion(),
        buildCommit: metadata.relayerReleaseSourceCommit || "development",
        platform: process.platform,
        architecture: process.arch,
      },
      onUnexpectedStop: () => {
        dialog.showErrorBox(
          "Relayer app server stopped",
          "Relayer needs to close because its local product service stopped. Reopen the app to continue.",
        );
        requestFatalShutdown();
      },
    });
    const productSession = await productServer.start();
    const publishCatalog = (snapshot, { signal } = {}) => (
      productServer.publishProviderCatalog(snapshot, { signal })
    );
    providerComposition = createProviderComposition({
      registry: productionProviderAdapterRegistry,
      definitionStore: productServer.providerDefinitionStore(),
      credentialStore: createEncryptedCredentialStore({
        path: join(userDataPath, "provider-credentials.json"),
        encrypt: async (value) => safeStorage.encryptString(value).toString("base64"),
        decrypt: async (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
      }),
      diagnostics: providerDiagnostics,
      removeRuntimeState: createProviderRuntimeStateRemover({
        runtimeRoot: providerRuntimeRoot,
        registry: productionProviderAdapterRegistry,
      }),
      providerStatuses: () => productServer.providerStatuses(),
      runtimeDependencies: async (definition) => {
        const requirement = managedRuntimeRequirementForHarness(
          compatibleHarnessImplementationForAdapter(definition.adapterId),
        );
        const managedRuntime = managedRuntimeDescriptor(await managedRuntimeResolver.get(
          requirement.runtimeId,
          requirement.minimumVersion,
        ));
        return productionProviderRuntimeDependencies(definition, {
          runtimeRoot: providerRuntimeRoot,
          legacyCodexHome,
          environment: process.env,
          managedRuntime,
        });
      },
      prepareRuntime: async ({ adapterId }) => {
        const requirement = managedRuntimeRequirementForHarness(
          compatibleHarnessImplementationForAdapter(adapterId),
        );
        await managedRuntimeResolver.prepare(requirement.runtimeId, requirement.minimumVersion);
      },
      publishCatalog,
    });
    ({ modelCatalog, providerDefinitions: providerSetup } = providerComposition);
    await providerComposition.start();
    const conversationExporter = createConversationExportService({
      dialog,
      getWindow: () => mainWindow,
      exportConversation: (threadId) => productServer.exportConversation(threadId),
    });

    registerDesktopIpc({
      ipcMain,
      dialog,
      shell,
      nativeTheme,
      credentials: accountService,
      accountChannel: accountService,
      modelCatalog,
      providerDefinitions: providerSetup,
      validateProviderOnboarding: () => productServer.validateProviderOnboarding(),
      conversationExporter,
      settings,
      tutorial,
      updater,
      getWindow: () => mainWindow,
      getAppearance: () => appearance,
      setAppearance: (value) => { appearance = value; },
      beforeUpdateInstall: async () => {
        if (!await confirmQuit()) return false;
        await shutdownServices();
        shutdownComplete = true;
        return true;
      },
      onUpdateInstallFailure: () => {
        app.relaunch();
        app.exit(1);
      },
    });
    mainWindow = await createWindow(productSession);
    primaryInstance.presentPendingWindow();
    mainWindow.on("closed", () => { mainWindow = undefined; });
    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = await createWindow(await productServer.start());
        mainWindow.on("closed", () => { mainWindow = undefined; });
      } else {
        primaryInstance.presentPrimaryWindow();
      }
    });
  }).catch((error) => {
    console.error("Relayer startup failed:", error);
    dialog.showErrorBox("Relayer could not start", error.message);
    app.quit();
  });

  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (quitFlowPromise) return;
    quitFlowPromise = (async () => {
      if (!await confirmQuit({ fatal: fatalShutdownRequested })) return;
      try {
        await shutdownServices();
      } catch (error) {
        console.error("Relayer shutdown failed:", error);
      }
      shutdownComplete = true;
      app.quit();
    })().finally(() => {
      if (!shutdownComplete) quitFlowPromise = undefined;
    });
  });
}
