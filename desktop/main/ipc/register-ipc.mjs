import { inspectFolder } from "../services/folder-service.mjs";

const MAX_COMPOSER_DRAFT_BYTES = 1024 * 1024;
const MAX_FOLLOWUP_DRAFTS = 256;

export function normalizeComposerDrafts(value) {
  const pending = value?.pendingNewThread;
  const followups = value?.threadFollowups;
  const normalized = {
    pendingNewThread: pending && typeof pending.text === "string"
      ? { text: pending.text, scope: pending.scope ?? null }
      : null,
    threadFollowups: followups && typeof followups === "object" && !Array.isArray(followups)
      ? Object.fromEntries(Object.entries(followups).filter(([, text]) => typeof text === "string"))
      : {},
  };
  const followupKeys = Object.keys(normalized.threadFollowups);
  for (const staleKey of followupKeys.slice(0, -MAX_FOLLOWUP_DRAFTS)) {
    delete normalized.threadFollowups[staleKey];
  }
  while (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_COMPOSER_DRAFT_BYTES) {
    const [staleKey] = Object.keys(normalized.threadFollowups);
    if (!staleKey) break;
    delete normalized.threadFollowups[staleKey];
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_COMPOSER_DRAFT_BYTES) {
    throw new TypeError("Composer drafts exceed the local persistence limit.");
  }
  return normalized;
}

export function registerComposerDraftIpc({ ipcMain, settings }) {
  ipcMain.handle("relayer:composer-drafts-read", async () => {
    const saved = await settings.read();
    return normalizeComposerDrafts(saved.composerDrafts);
  });
  ipcMain.handle("relayer:composer-drafts-write", async (_event, value) => {
    const composerDrafts = normalizeComposerDrafts(value);
    await settings.update((current) => ({ ...current, composerDrafts }));
    return composerDrafts;
  });
}

export function registerDesktopIpc({
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  credentials,
  accountChannel = credentials,
  modelCatalog,
  providerDefinitions = null,
  validateProviderOnboarding = null,
  conversationExporter,
  settings,
  tutorial,
  updater,
  getWindow,
  getAppearance,
  setAppearance,
  beforeUpdateInstall = async () => {},
  onUpdateInstallFailure = async () => {},
}) {
  const normalizeAppearance = (value) => value === "light" ? "light" : "dark";

  if (credentials) {
    ipcMain.handle("relayer:account-read", () => credentials.account());
    ipcMain.handle("relayer:account-login", async () => {
      const result = await credentials.login();
      if (result?.authUrl) await shell.openExternal(result.authUrl);
      return result?.authUrl
        ? { status: "pending", loginId: result?.loginId ?? null }
        : result;
    });
    ipcMain.handle("relayer:account-logout", () => credentials.logout());
  }
  ipcMain.handle("relayer:model-catalog-settings-open", () => modelCatalog.settingsOpened());
  ipcMain.handle("relayer:model-catalog-refresh", (_event, providerId) => modelCatalog.explicitRefresh(providerId));
  ipcMain.handle("relayer:provider-status", async () => {
    if (!providerDefinitions) return null;
    const saved = await settings.read();
    let hasCompletedOnboarding = saved.providerOnboardingComplete === true;
    if (saved.providerOnboardingComplete == null && validateProviderOnboarding) {
      hasCompletedOnboarding = Boolean(await validateProviderOnboarding());
      if (hasCompletedOnboarding) {
        await settings.update((current) => ({ ...current, providerOnboardingComplete: true }));
      }
    }
    return {
      adapters: providerDefinitions.adapters(),
      definitions: await providerDefinitions.list(),
      hasCompletedOnboarding,
    };
  });
  ipcMain.handle("relayer:provider-connect", async (_event, input) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    const result = await providerDefinitions.connect(input);
    if (result.login?.authUrl) await shell.openExternal(result.login.authUrl);
    getWindow()?.webContents.send("relayer:providers-changed", {
      kind: result.status === "connected" ? "connected" : "connection_pending",
      providerId: result.providerDefinition.id,
    });
    return result;
  });
  ipcMain.handle("relayer:provider-connect-complete", async (_event, { connectionId }) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    const result = await providerDefinitions.completeConnection(connectionId);
    getWindow()?.webContents.send("relayer:providers-changed", {
      kind: result.status === "connected" ? "connected" : "connection_pending",
      providerId: result.providerDefinition.id,
    });
    return result;
  });
  ipcMain.handle("relayer:provider-connect-cancel", async (_event, { connectionId }) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    return { cancelled: await providerDefinitions.cancelConnection(connectionId) };
  });
  ipcMain.handle("relayer:provider-rename", async (_event, { id, label }) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    const definition = await providerDefinitions.rename(id, label);
    getWindow()?.webContents.send("relayer:providers-changed", { kind: "renamed", providerId: definition.id });
    return definition;
  });
  ipcMain.handle("relayer:provider-logout", async (_event, { id }) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    const account = await providerDefinitions.logout(id);
    getWindow()?.webContents.send("relayer:providers-changed", { kind: "logged_out", providerId: id });
    return account;
  });
  ipcMain.handle("relayer:provider-reconnect", async (_event, { id }) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    const result = await providerDefinitions.reconnect(id);
    if (result.login?.authUrl) await shell.openExternal(result.login.authUrl);
    getWindow()?.webContents.send("relayer:providers-changed", {
      kind: "reconnect_pending",
      providerId: result.providerDefinition.id,
    });
    return result;
  });
  ipcMain.handle("relayer:provider-remove", async (_event, { id }) => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    const definition = await providerDefinitions.remove(id);
    getWindow()?.webContents.send("relayer:providers-changed", { kind: "removal_requested", providerId: definition.id });
    return definition;
  });
  ipcMain.handle("relayer:provider-onboarding-complete", async () => {
    if (!providerDefinitions) throw new Error("Provider setup is unavailable.");
    if (!validateProviderOnboarding || !await validateProviderOnboarding()) {
      throw new Error("A working default provider, family, and harness are required to continue.");
    }
    await settings.update((current) => ({ ...current, providerOnboardingComplete: true }));
    return { hasCompletedOnboarding: true };
  });
  ipcMain.handle("relayer:conversation-export", (_event, threadId) => conversationExporter.save(threadId));
  ipcMain.handle("relayer:folder-choose", async () => {
    const selection = await dialog.showOpenDialog(getWindow(), {
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return inspectFolder(selection.filePaths[0]);
  });
  ipcMain.handle("relayer:appearance-read", () => ({ appearance: getAppearance() }));
  ipcMain.handle("relayer:appearance-set", async (_event, value) => {
    const appearance = normalizeAppearance(value);
    setAppearance(appearance);
    nativeTheme.themeSource = appearance;
    getWindow()?.setBackgroundColor(appearance === "light" ? "#fafafa" : "#0b0c0d");
    await settings.update((current) => ({ ...current, appearance }));
    return { appearance };
  });
  registerComposerDraftIpc({ ipcMain, settings });
  ipcMain.handle("relayer:tutorial-read", (_event, context) => tutorial.read(context));
  ipcMain.handle("relayer:tutorial-begin-automatic", (_event, context) => tutorial.beginAutomatic(context));
  ipcMain.handle("relayer:tutorial-begin-manual", () => tutorial.beginManual());
  ipcMain.handle("relayer:tutorial-dismiss", () => tutorial.dismiss());
  ipcMain.handle("relayer:tutorial-complete", () => tutorial.complete());
  ipcMain.handle("relayer:update-status", () => updater.status());
  ipcMain.handle("relayer:update-check", () => updater.check());
  ipcMain.handle("relayer:update-download", () => updater.download());
  ipcMain.handle("relayer:update-install", async () => {
    if (updater.status().phase !== "ready") throw new Error("No verified update is ready to install.");
    try {
      const proceed = await beforeUpdateInstall();
      if (proceed === false) return { installing: false };
      updater.install();
      return { installing: true };
    } catch (error) {
      await onUpdateInstallFailure(error);
      throw error;
    }
  });
  ipcMain.handle("relayer:update-channel", async (_event, channel) => {
    const state = updater.setChannel(channel);
    await accountChannel?.setChannel(channel);
    await settings.update((current) => ({ ...current, updateChannel: channel }));
    return state;
  });
}
