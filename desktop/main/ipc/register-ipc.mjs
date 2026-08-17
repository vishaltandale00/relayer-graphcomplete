import { inspectFolder } from "../services/folder-service.mjs";

export function registerDesktopIpc({
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  credentials,
  settings,
  updater,
  getWindow,
  getAppearance,
  setAppearance,
  beforeUpdateInstall = async () => {},
}) {
  const normalizeAppearance = (value) => value === "light" ? "light" : "dark";

  ipcMain.handle("relayer:account-read", () => credentials.account());
  ipcMain.handle("relayer:account-login", async () => {
    const result = await credentials.login();
    if (result?.authUrl) await shell.openExternal(result.authUrl);
    return { status: "pending", loginId: result?.loginId ?? null };
  });
  ipcMain.handle("relayer:account-logout", () => credentials.logout());
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
    await settings.write({ ...(await settings.read()), appearance });
    return { appearance };
  });
  ipcMain.handle("relayer:update-status", () => updater.status());
  ipcMain.handle("relayer:update-check", () => updater.check());
  ipcMain.handle("relayer:update-download", () => updater.download());
  ipcMain.handle("relayer:update-install", async () => {
    if (updater.status().phase !== "ready") throw new Error("No verified update is ready to install.");
    await beforeUpdateInstall();
    updater.install();
    return { installing: true };
  });
  ipcMain.handle("relayer:update-channel", async (_event, channel) => {
    const state = updater.setChannel(channel);
    await settings.write({ ...(await settings.read()), updateChannel: channel });
    return state;
  });
}
