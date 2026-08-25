import { inspectFolder } from "../services/folder-service.mjs";

export function registerDesktopIpc({
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  credentials,
  modelCatalog,
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

  ipcMain.handle("relayer:account-read", () => credentials.account());
  ipcMain.handle("relayer:account-login", async () => {
    const result = await credentials.login();
    if (result?.authUrl) await shell.openExternal(result.authUrl);
    return { status: "pending", loginId: result?.loginId ?? null };
  });
  ipcMain.handle("relayer:account-logout", () => credentials.logout());
  ipcMain.handle("relayer:model-catalog-settings-open", () => modelCatalog.settingsOpened());
  ipcMain.handle("relayer:model-catalog-refresh", (_event, providerId) => modelCatalog.explicitRefresh(providerId));
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
      await beforeUpdateInstall();
      updater.install();
      return { installing: true };
    } catch (error) {
      await onUpdateInstallFailure(error);
      throw error;
    }
  });
  ipcMain.handle("relayer:update-channel", async (_event, channel) => {
    const state = updater.setChannel(channel);
    await settings.update((current) => ({ ...current, updateChannel: channel }));
    return state;
  });
}
