import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, shell } from "electron";
import electronUpdater from "electron-updater";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import {
  productionProviderAdapterRegistry,
  productionProviderRuntimeDependencies,
} from "./providers/provider-adapter-registry.mjs";
import { createProviderComposition } from "./providers/provider-composition.mjs";
import { createProviderDiagnosticsLog } from "./providers/provider-diagnostics-log.mjs";
import { createProviderRuntimeStateRemover } from "./providers/provider-runtime-state.mjs";
import {
  createEncryptedCredentialStore,
} from "./providers/provider-definition-store.mjs";
import { registerDesktopIpc } from "./ipc/register-ipc.mjs";
import { RelayerAppServerService } from "./services/relayer-app-server.mjs";
import { createCanaryEvidenceLog } from "./services/canary-evidence-log.mjs";
import { GraphCompleteRuntimeService } from "./services/graphcomplete-runtime.mjs";
import { resolveDesktopHarnessConfiguration } from "./services/desktop-harness-configuration.mjs";
import { createSettingsStore } from "./services/settings-store.mjs";
import { createDesktopUpdater, resolveUpdateChannel } from "./services/updater.mjs";
import { claimPrimaryDesktopInstance } from "./single-instance.mjs";
import { createWindowFactory } from "./window.mjs";
import {
  DESKTOP_UPDATE_BASE_URL,
  packagedDesktopReleaseMetadata,
} from "../shared/release-metadata.mjs";
import { codexBinaryPath, nativeBinaryName } from "../shared/target.mjs";

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
const updateBaseUrl = packagedRelease?.updateBaseUrl || (
  app.isPackaged ? null : process.env.RELAYER_DESKTOP_UPDATE_BASE_URL || DESKTOP_UPDATE_BASE_URL
);
const bundledCodexBinary = codexBinaryPath({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  repositoryRoot,
});
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
const rendererDirectory = app.isPackaged
  ? join(process.resourcesPath, "renderer")
  : join(desktopDirectory, "renderer");
const defaultHarnessConfiguration = resolveDesktopHarnessConfiguration({
  isPackaged: app.isPackaged,
  environment: process.env,
});

let mainWindow;
const primaryInstance = claimPrimaryDesktopInstance({ app, getWindow: () => mainWindow });

if (primaryInstance) {
  let appearance = "dark";
  const settings = createSettingsStore(userDataPath);
  const graphRuntime = new GraphCompleteRuntimeService({
    userDataDirectory: userDataPath,
    graphServerBinary: relayerGraphServerBinary,
    configurationPaths: [...new Set([
      defaultHarnessConfiguration,
      "codex-basic",
      "codex-basic-high",
      "claude-basic",
    ])].map((name) => join(harnessDirectory, `${name}.yaml`)),
    codexBasicClientModuleUrl: graphClientModuleUrl,
    codexPathOverride: bundledCodexBinary,
    acquireProviderExecution: (providerId) => {
      if (!providerSetup) throw new Error("Provider execution broker is not ready.");
      return providerSetup.acquireExecution(providerId);
    },
    onUnexpectedStop: () => {
      dialog.showErrorBox(
        "Relayer graph service stopped",
        "Relayer needs to close because its local graph service stopped. Reopen the app to continue.",
      );
      app.quit();
    },
  });
  let productServer;
  let modelCatalog;
  let providerSetup;
  let providerComposition;

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

  async function shutdownServices() {
    shutdownPromise ??= (async () => {
      const results = [];
      try {
        if (productServer) await productServer.close();
      } catch (error) {
        results.push({ status: "rejected", reason: error });
      }
      results.push(...await Promise.allSettled([
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
    const runtimeSession = await graphRuntime.start();
    productServer = new RelayerAppServerService({
      userDataDirectory: userDataPath,
      binaryPath: relayerAppServerBinary,
      webDirectory: rendererDirectory,
      permissionCatalogPath,
      runtimeSession,
      defaultHarnessConfiguration,
      allowHarnessOverride: !app.isPackaged && defaultHarnessConfiguration.startsWith("prime-agent-"),
      onUnexpectedStop: () => {
        dialog.showErrorBox(
          "Relayer app server stopped",
          "Relayer needs to close because its local product service stopped. Reopen the app to continue.",
        );
        app.quit();
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
      runtimeDependencies: (definition) => productionProviderRuntimeDependencies(definition, {
        runtimeRoot: providerRuntimeRoot,
        environment: process.env,
        codexBinary: bundledCodexBinary,
        claudeBinary: process.env.RELAYER_CLAUDE_BINARY,
      }),
      publishCatalog,
    });
    ({ modelCatalog, providerDefinitions: providerSetup } = providerComposition);
    await providerComposition.start();

    registerDesktopIpc({
      ipcMain,
      dialog,
      shell,
      nativeTheme,
      modelCatalog,
      providerDefinitions: providerSetup,
      validateProviderOnboarding: () => productServer.validateProviderOnboarding(defaultHarnessConfiguration),
      settings,
      updater,
      getWindow: () => mainWindow,
      getAppearance: () => appearance,
      setAppearance: (value) => { appearance = value; },
      beforeUpdateInstall: async () => {
        await shutdownServices();
        shutdownComplete = true;
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
    void shutdownServices().catch((error) => {
      console.error("Relayer shutdown failed:", error);
    }).finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });
}
