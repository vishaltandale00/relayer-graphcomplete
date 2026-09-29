import { createSharePreviewCapture } from "./services/share-preview-capture.mjs";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, safeStorage, shell } from "electron";
import electronUpdater from "electron-updater";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import {
  productionProviderAdapterRegistry,
  productionHarnessRuntimeDescriptor,
  productionProviderRuntimeDependencies,
  resolveLegacyCodexHome,
} from "./providers/provider-adapter-registry.mjs";
import { createProviderComposition } from "./providers/provider-composition.mjs";
import { createProviderDiagnosticsLog } from "./providers/provider-diagnostics-log.mjs";
import { removeLeftoverEphemeralCodexAuthFiles } from "./providers/ephemeral-codex-auth.mjs";
import { createProviderRuntimeStateRemover } from "./providers/provider-runtime-state.mjs";
import {
  createEncryptedCredentialStore,
} from "./providers/provider-definition-store.mjs";
import { registerDesktopIpc } from "./ipc/register-ipc.mjs";
import { createConversationExportService } from "./services/conversation-export.mjs";
import { createSharePublishCoordinator } from "./services/share-publish-coordinator.mjs";
import { createSharePublishAttemptStore } from "./services/share-publish-attempt-store.mjs";
import { createShareServiceClient } from "./services/share-service-client.mjs";
import { resolveShareServiceEndpoint } from "./services/share-service-endpoint.mjs";
import { createShareSourceThreadIdentity } from "./services/share-source-thread-identity.mjs";
import {
  createDesktopAccountTelemetry,
  createDesktopErrorReporterIssuer,
  initializeDesktopAuthenticatedErrorReporting,
  setDesktopAuthenticatedErrorChannel,
} from "./services/authenticated-error-startup.mjs";
import { inspectCodexBrowserMcpRuntime } from "./services/codex-browser-mcp-runtime.mjs";
import { RelayerAppServerService } from "./services/relayer-app-server.mjs";
import { installElectronMainErrorAdapter } from "./services/electron-main-error-adapter.mjs";
import { createCanaryEvidenceLog } from "./services/canary-evidence-log.mjs";
import { settleShutdownWithin } from "./services/update-restart.mjs";
import { createDesktopGraphRuntime, productTemporalFeatures } from "./services/graphcomplete-runtime.mjs";
import {
  inspectPrimeAgentRuntime,
  PRIME_AGENT_ASSET_SHA256,
  requirePrimeAgentRuntime,
  selectPrimeAgentDependencyClosureSha256,
} from "./services/prime-agent-runtime.mjs";
import {
  assemblePrimeManagedRuntime,
  checkPrimeManagedRuntime,
  createPrimeReviewedTreeCopier,
} from "./services/prime-managed-runtime.mjs";
import { resolveDesktopHarnessConfiguration } from "./services/desktop-harness-configuration.mjs";
import { createSettingsStore } from "./services/settings-store.mjs";
import { createTutorialLifecycle } from "./services/tutorial-lifecycle.mjs";
import {
  createDesktopAccountService,
  GRAPHCOMPLETE_AUTH0,
  GRAPHCOMPLETE_LOGIN_URL,
} from "./services/desktop-account-service.mjs";
import { createDesktopUpdater, resolveUpdateChannel } from "./services/updater.mjs";
import { createManagedRuntimeInstaller, runtimesChangedByActivation } from "./managed-runtimes/installer.mjs";
import { createManagedRuntimeResolver, managedRecipeInstalled } from "./managed-runtimes/resolver.mjs";
import { createHarnessReadinessCoordinator, createPostUpgradeReadiness } from "./services/harness-readiness.mjs";
import { confirmManagedRuntimeQuit } from "./managed-runtimes/quit-guard.mjs";
import { claimPrimaryDesktopInstance } from "./single-instance.mjs";
import { createWindowFactory } from "./window.mjs";
import { resolvedAppearance, startAppearance } from "./appearance.mjs";
import {
  DESKTOP_UPDATE_BASE_URL,
  packagedDesktopReleaseMetadata,
} from "../shared/release-metadata.mjs";
import { developmentTelemetryPackageMetadata } from "../shared/telemetry-release.mjs";
import { nativeBinaryName } from "../shared/target.mjs";
import {
  activeProviderRuntimeRequirements,
  HARNESS_MANAGED_RUNTIME_REQUIREMENTS,
  compatibleHarnessImplementationForAdapter,
  managedRuntimeRequirementForAdapter,
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
// Electron's app.getVersion() is unreliable for the unsigned development app: with no
// package.json at the app path it falls back to a value that is not valid semver on
// Linux ("0.0"), which the managed-runtime and updater code reject. Use the product
// version declared in package.json for development builds; packaged releases keep the
// sealed app version.
const desktopVersion = app.isPackaged ? app.getVersion() : (metadata.version || app.getVersion());
app.setName(metadata.relayerProductName || "Relayer Dev");

const userDataPath = app.getPath("userData");
const providerRuntimeRoot = join(userDataPath, "provider-runtimes");
const primeAppRoot = app.isPackaged ? app.getAppPath() : repositoryRoot;
const primePythonClientRoot = app.isPackaged
  ? join(process.resourcesPath, "python", "relayer-graph", "src")
  : join(repositoryRoot, "python", "relayer-graph", "src");
const managedRuntimeInstaller = createManagedRuntimeInstaller({
  root: join(userDataPath, "managed-runtimes"),
  assembleRecipe: async (context) => {
    if (context.recipe.runtimeId !== "prime") return;
    await assemblePrimeManagedRuntime(context, {
      copyReviewedTrees: createPrimeReviewedTreeCopier({
        appRoot: primeAppRoot,
        pythonClientRoot: primePythonClientRoot,
        expectedClosureSha256: selectPrimeAgentDependencyClosureSha256({
          isPackaged: app.isPackaged,
          javascriptContract: context.recipe.runtimeContract.javascript,
        }),
        expectedPythonClientSha256: PRIME_AGENT_ASSET_SHA256.pythonPackageTree,
      }),
    });
  },
});
const managedRuntimeResolver = createManagedRuntimeResolver(managedRuntimeInstaller);
// Runtime ids this start's app update changed; filled before the graph runtime starts.
const updatedRuntimeIds = new Set();
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
  const settings = createSettingsStore(userDataPath);
  const tutorial = createTutorialLifecycle({ settings });
  let authenticatedErrorReporting;
  let electronMainErrorAdapter;
  const issueErrorReporter = createDesktopErrorReporterIssuer({
    getReporting: () => authenticatedErrorReporting,
  });
  const issueErrorCapability = (component, processGeneration) => (
    authenticatedErrorReporting?.issueCapability({ component, processGeneration }) ?? null
  );
  let fatalShutdownRequested = false;
  const requestFatalShutdown = () => {
    fatalShutdownRequested = true;
    app.quit();
  };
  const graphRuntime = createDesktopGraphRuntime({
    userDataDirectory: userDataPath,
    graphServerBinary: relayerGraphServerBinary,
    configurationPaths: [...new Set([
      defaultHarnessConfiguration,
      "codex-basic",
      "claude-basic",
      ...(primeAgentRuntime.available ? primeAgentRuntime.configurationNames : []),
    ])].map((name) => join(harnessDirectory, `${name}.yaml`)),
    unavailableConfigurations: primeAgentRuntime.available ? [] : ["prime-agent-basic"].map((name) => ({
      name,
      reason: { code: primeAgentRuntime.code, message: primeAgentRuntime.message },
      diagnostics: primeAgentRuntime.diagnostics,
    })),
    codexBasicClientModuleUrl: graphClientModuleUrl,
    temporalFeatures: productTemporalFeatures(),
    ...(codexBrowserMcpInspection.available ? { codexBrowserMcpRuntime: codexBrowserMcpInspection } : {}),
    acquireProviderExecution: (providerId) => {
      if (!providerSetup) throw new Error("Provider execution broker is not ready.");
      return providerSetup.acquireExecution(providerId);
    },
    acknowledgeUnknownProviderRelease: () => providerSetup?.finalizeDrainedRemovals(),
    issueErrorReporter,
    issueErrorCapability,
    onUnexpectedStop: () => {
      dialog.showErrorBox(
        "Relayer graph service stopped",
        "Relayer needs to close because its local graph service stopped. Reopen the app to continue.",
      );
      requestFatalShutdown();
    },
    resolveCodexRuntime: async () => managedRuntimeDescriptor(await managedRuntimeResolver.get(
      managedRuntimeRequirementForHarness("codex.basic").recipeId,
    )),
    resolveClaudeRuntime: async () => managedRuntimeDescriptor(await managedRuntimeResolver.get(
      managedRuntimeRequirementForHarness("claude.basic").recipeId,
    )),
    resolvePrimeRuntime: async () => managedRuntimeDescriptor(await managedRuntimeResolver.get(
      managedRuntimeRequirementForHarness("prime.agent").recipeId,
    )),
    validateHarnessRuntime: async (configuration) => {
      const requirement = managedRuntimeRequirementForHarness(configuration.implementation);
      await managedRuntimeResolver.validate(requirement.recipeId);
      return true;
    },
    harnessRuntimeRecipe: (configuration) => managedRuntimeInstaller.recipeIdentity(
      managedRuntimeRequirementForHarness(configuration.implementation).recipeId,
    ),
    harnessRuntimeUpdated: (configuration) => updatedRuntimeIds.has(
      managedRuntimeRequirementForHarness(configuration.implementation).runtimeId,
    ),
    onHarnessRuntimeValidationFailure: async (configuration, error) => {
      await providerDiagnostics.write({
        level: "error",
        category: "harness_startup_validation_failed",
        harnessId: configuration.name,
        code: typeof error?.code === "string" ? error.code : "managed_runtime_local_validation_failed",
      });
    },
    coordinateHarnessReadiness: true,
  });
  let productServer;
  let modelCatalog;
  let providerSetup;
  let providerComposition;
  let accountService;
  const accountTelemetry = createDesktopAccountTelemetry({
    getReporting: () => authenticatedErrorReporting,
    refreshChildren: async () => {
      await Promise.allSettled([
        graphRuntime.refreshErrorCapability(),
        productServer?.refreshErrorCapability(),
      ]);
    },
  });

  function createAccountService(channel) {
    return createDesktopAccountService({
      channel,
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
      openExternal: (url) => shell.openExternal(url, { activate: true }),
      emit: (state) => mainWindow?.webContents.send("relayer:account-changed", state),
      presentWindow: () => { primaryInstance?.presentPrimaryWindow(); },
      telemetry: accountTelemetry,
    });
  }

  const managedRuntimeDescriptor = (runtime) => productionHarnessRuntimeDescriptor(runtime);

  const canaryEvidenceLog = createCanaryEvidenceLog({
    appIsPackaged: app.isPackaged,
    releaseMetadata: packagedRelease,
  });
  const providerDiagnostics = createProviderDiagnosticsLog({
    path: join(userDataPath, "logs", "providers.jsonl"),
  });

  const updater = createDesktopUpdater({
    // The platform auto-updater is only used by packaged release artifacts. Reading
    // electron-updater's lazy `autoUpdater` getter eagerly constructs the per-platform
    // updater, and the Linux AppImageUpdater rejects the unsigned dev version at
    // construction. Development builds never touch the updater, so skip constructing it.
    autoUpdater: app.isPackaged && releaseArtifact ? electronUpdater.autoUpdater : null,
    app: {
      get isPackaged() { return app.isPackaged && releaseArtifact; },
      getVersion: () => desktopVersion,
    },
    updateBaseUrl,
    prefetchRuntimeUpdate: async (info) => {
      if (!providerSetup) return;
      const incoming = parseUpdateRuntimeRequirements(info);
      const requirements = activeProviderRuntimeRequirements(await providerSetup.list())
        .map(({ runtimeId }) => ({ runtimeId, recipeId: incoming[runtimeId] }));
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
    getAppearance: () => resolvedAppearance(nativeTheme),
    updater,
    openExternal: (url) => shell.openExternal(url, { activate: true }),
    issueErrorReporter,
  });

  let shutdownPromise;
  let shutdownComplete = false;
  let quitFlowPromise;
  // The background post-upgrade readiness evaluation (#556), fenced for shutdown.
  let postUpgradeReadiness = null;

  // Quitting first stops the post-upgrade evaluation, so no preparation starts behind the
  // quit guard's check; one already running is an installer operation the guard sees. If
  // the user keeps downloading, an unfinished evaluation starts again.
  const confirmManagedQuit = ({ fatal = false } = {}) => confirmManagedRuntimeQuit({
    installer: managedRuntimeInstaller,
    dialog,
    parent: mainWindow,
    fatal,
    ...(fatal ? { reason: new Error("Relayer is closing after a fatal service failure.") } : {}),
  });
  const confirmQuit = (options) => (postUpgradeReadiness
    ? postUpgradeReadiness.confirmQuit(() => confirmManagedQuit(options))
    : confirmManagedQuit(options));

  const UPDATE_RESTART_SHUTDOWN_BUDGET_MS = 10_000;

  async function settleShutdownForUpdateRestart() {
    await settleShutdownWithin({
      shutdown: shutdownServices,
      budgetMs: UPDATE_RESTART_SHUTDOWN_BUDGET_MS,
      onTimeout: (budgetMs) => console.error(
        `Relayer services did not stop within ${budgetMs}ms. `
        + "Continuing with the update restart; child processes were already terminated.",
      ),
      onError: (error) => console.error("Relayer shutdown failed before the update restart:", error),
    });
  }

  async function shutdownServices() {
    shutdownPromise ??= (async () => {
      const results = [];
      // Provider admission closes first, so no turn takes provider access while shutdown
      // awaits the app server; the provider teardown below would close it underneath (PROV-004).
      providerComposition?.beginShutdown();
      updater.stopPolling();
      // No post-upgrade preparation outlives shutdown: stop the step, cancel any installer
      // operation it started, and let it settle before the services it uses close.
      await postUpgradeReadiness?.stopForShutdown(() => (
        managedRuntimeInstaller.cancelAll(new DOMException("Relayer is shutting down.", "AbortError"))
      ));
      try {
        electronMainErrorAdapter?.close();
      } catch (error) {
        results.push({ status: "rejected", reason: error });
      }
      try {
        if (productServer) await productServer.close();
      } catch (error) {
        results.push({ status: "rejected", reason: error });
      }
      try {
        if (accountService) await accountService.close();
      } catch (error) {
        results.push({ status: "rejected", reason: error });
      }
      void authenticatedErrorReporting?.close().catch(() => undefined);
      results.push(...await Promise.allSettled([
        settings.flush(),
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
    startAppearance(nativeTheme, saved.appearance, () => mainWindow);
    const channel = resolveUpdateChannel(saved.updateChannel);
    const telemetryPackageMetadata = app.isPackaged
      ? metadata
      : developmentTelemetryPackageMetadata(desktopVersion);
    authenticatedErrorReporting = await initializeDesktopAuthenticatedErrorReporting({
      userDataPath,
      packageMetadata: telemetryPackageMetadata,
      appVersion: desktopVersion,
      platform: process.platform,
      architecture: process.arch,
      currentUpdateChannel: releaseArtifact ? channel : "development",
      safeStorage,
      onUnavailable: () => console.error("Authenticated error reporting unavailable."),
    });
    electronMainErrorAdapter = installElectronMainErrorAdapter({ issueErrorReporter });
    accountService = createAccountService(channel);
    if (channel === "preview") updater.setChannel("preview");
    void accountService.start().catch((error) => console.error("Optional desktop account initialization failed:", error));
    const activation = await managedRuntimeInstaller.activatePendingAppUpdate(desktopVersion);
    // Runtimes this update changed: a new recipe activated, or activation failed. Startup
    // tells the app server, which withholds their old ready and marks them due.
    for (const runtimeId of runtimesChangedByActivation(activation)) updatedRuntimeIds.add(runtimeId);
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
    // codex.basic no longer writes an API-key auth.json. Remove any a build
    // that did left under a provider home, since it would hold a plaintext key.
    const leftoverAuth = await removeLeftoverEphemeralCodexAuthFiles(providerRuntimeRoot);
    if (leftoverAuth.failures.length) {
      console.error("Leftover Codex API-key auth cleanup failed:", new AggregateError(
        leftoverAuth.failures.map(({ error }) => error),
        "One or more leftover Codex API-key auth files could not be removed.",
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
        desktopVersion,
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
      issueErrorReporter,
      issueErrorCapability,
    });
    const productSession = await productServer.start();
    const readiness = createHarnessReadinessCoordinator({
      configurations: runtimeSession.configurations,
      digestConfiguration: runtimeSession.digestConfiguration,
      runtimeRequirements: HARNESS_MANAGED_RUNTIME_REQUIREMENTS,
      prepareRecipe: async (recipeId) => managedRuntimeDescriptor(
        await managedRuntimeResolver.prepare(recipeId),
      ),
      checkers: {
        "codex.basic": async ({ runtime }) => ({
          available: runtime?.runtimeId === "codex"
            && typeof runtime.executable === "string"
            && runtime.executable.trim() !== ""
            && runtime.environment !== null
            && typeof runtime.environment === "object",
        }),
        "claude.basic": async ({ runtime }) => ({
          available: runtime?.runtimeId === "claude"
            && typeof runtime.executable === "string"
            && runtime.executable.trim() !== ""
            && typeof runtime.moduleUrl === "string"
            && runtime.moduleUrl.trim() !== ""
            && runtime.environment !== null
            && typeof runtime.environment === "object",
        }),
        "prime.agent": ({ runtime, signal }) => checkPrimeManagedRuntime({ runtime, signal }),
      },
      // The app server's record is the only readiness record (PROV-006).
      publishAvailability: (updates) => productServer.publishHarnessReadiness(updates),
      recipeInstalled: (recipeId) => managedRecipeInstalled(managedRuntimeResolver, recipeId),
      diagnostics: providerDiagnostics,
    });
    const publishCatalog = (snapshot, { signal, connectionGeneration, connectionEvent } = {}) => (
      productServer.publishProviderCatalog(snapshot, { signal, connectionGeneration, connectionEvent })
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
        if (definition.accessContract === "secret@1") {
          return productionProviderRuntimeDependencies(definition, {
            runtimeRoot: providerRuntimeRoot,
            legacyCodexHome,
            environment: process.env,
          });
        }
        const requirement = managedRuntimeRequirementForHarness(
          compatibleHarnessImplementationForAdapter(definition.adapterId),
        );
        const managedRuntime = managedRuntimeDescriptor(await managedRuntimeResolver.get(
          requirement.recipeId,
        ));
        return productionProviderRuntimeDependencies(definition, {
          runtimeRoot: providerRuntimeRoot,
          legacyCodexHome,
          environment: process.env,
          managedRuntime,
        });
      },
      prepareRuntime: async ({ adapterId }) => {
        const descriptor = productionProviderAdapterRegistry.get(adapterId);
        if (descriptor.accessContract === "secret@1") return;
        const requirement = managedRuntimeRequirementForHarness(
          compatibleHarnessImplementationForAdapter(adapterId),
        );
        await managedRuntimeResolver.prepare(requirement.recipeId);
      },
      evaluateReadiness: (request) => readiness.evaluate(request),
      publishCatalog,
    });
    ({ modelCatalog, providerDefinitions: providerSetup } = providerComposition);
    await providerComposition.start();
    // #556: an upgrade that changed a route's configuration digest, or activated a new
    // runtime recipe, gets one readiness evaluation through the recipe-update trigger. It
    // runs in the background, so startup's cheap path never waits for it.
    postUpgradeReadiness = createPostUpgradeReadiness({
      readiness,
      updatesDue: () => productServer.harnessReadinessUpdatesDue(),
      recipeUpdates: activation.recipeUpdates,
      composition: providerComposition,
      recipeForAdapter: (adapterId) => managedRuntimeRequirementForAdapter(adapterId).recipeId,
      onError: (error) => console.error("Post-upgrade harness readiness evaluation failed:", error),
    });
    postUpgradeReadiness.start();
    const conversationExporter = createConversationExportService({
      dialog,
      getWindow: () => mainWindow,
      exportConversation: (threadId) => productServer.exportConversation(threadId),
    });
    const shareServiceClient = createShareServiceClient({
      endpoint: resolveShareServiceEndpoint({ isPackaged: app.isPackaged, packagedRelease, metadata, environment: process.env }),
    });
    const shareCoordinator = createSharePublishCoordinator({
      capturePreview: createSharePreviewCapture({BrowserWindow,session,rendererDirectory}),
      getTheme: () => resolvedAppearance(nativeTheme),
      exportSnapshot: (threadId, title, options) => productServer.exportShareSnapshot(threadId, title, options),
      accountSession: () => accountService.shareSession(),
      sourceThreadIdentity: createShareSourceThreadIdentity({ settings }),
      publish: (request) => shareServiceClient.publish(request),
      preflightPublication: (request) => shareServiceClient.preflight(request),
      issueHandledShareFailureReporter: (identity) => (
        authenticatedErrorReporting?.issueHandledShareFailureReporter(identity) ?? null
      ),
      attemptStore: createSharePublishAttemptStore({
        directory: join(userDataPath, "share-publish-attempts"),
      }),
    });

    registerDesktopIpc({
      ipcMain,
      dialog,
      shell,
      nativeTheme,
      credentials: accountService,
      presentWindow: () => { primaryInstance?.presentPrimaryWindow(); },
      accountChannel: {
        setChannel: (nextChannel) => setDesktopAuthenticatedErrorChannel({
          reporting: authenticatedErrorReporting,
          account: accountService,
          releaseArtifact,
          channel: nextChannel,
        }),
      },
      modelCatalog,
      providerDefinitions: providerSetup,
      validateProviderOnboarding: () => productServer.validateProviderOnboarding(),
      conversationExporter,
      shareCoordinator,
      settings,
      tutorial,
      updater,
      getWindow: () => mainWindow,
      beforeUpdateInstall: async () => {
        if (!await confirmQuit()) return false;
        await settleShutdownForUpdateRestart();
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
