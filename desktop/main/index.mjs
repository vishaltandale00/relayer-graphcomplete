import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import electronUpdater from "electron-updater";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CodexCredentialAdapter } from "./credentials/codex-credential-adapter.mjs";
import { registerDesktopIpc } from "./ipc/register-ipc.mjs";
import { createSettingsStore } from "./services/settings-store.mjs";
import { createDesktopUpdater } from "./services/updater.mjs";
import { createWindowFactory } from "./window.mjs";
import {
  DESKTOP_UPDATE_BASE_URL,
  packagedDesktopReleaseMetadata,
} from "../shared/release-metadata.mjs";

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
const codexHome = process.env.RELAYER_CODEX_HOME || join(userDataPath, "codex-home");
const updateBaseUrl = packagedRelease?.updateBaseUrl || (
  app.isPackaged ? null : process.env.RELAYER_DESKTOP_UPDATE_BASE_URL || DESKTOP_UPDATE_BASE_URL
);
const bundledCodexBinary = app.isPackaged
  ? join(process.resourcesPath, "app.asar.unpacked", "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex")
  : join(repositoryRoot, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex");

let mainWindow;
let appearance = "dark";
const settings = createSettingsStore(userDataPath);

const credentials = new CodexCredentialAdapter({
  environment: { ...process.env, CODEX_HOME: codexHome, RELAYER_CODEX_BINARY: bundledCodexBinary },
  onAccountChanged: (event) => {
    if (event?.status === "unavailable") {
      mainWindow?.webContents.send("relayer:account-changed", event);
      return;
    }
    void credentials.account().then((account) => mainWindow?.webContents.send("relayer:account-changed", account));
  },
});

const updater = createDesktopUpdater({
  autoUpdater: electronUpdater.autoUpdater,
  app: {
    get isPackaged() { return app.isPackaged && releaseArtifact; },
    getVersion: () => app.getVersion(),
  },
  updateBaseUrl,
  emit: (state) => mainWindow?.webContents.send("relayer:update-changed", state),
});

const createWindow = createWindowFactory({
  BrowserWindow,
  app,
  desktopDirectory,
  getAppearance: () => appearance,
  updater,
});

app.whenReady().then(async () => {
  await mkdir(codexHome, { recursive: true });
  const saved = await settings.read();
  appearance = saved.appearance === "light" ? "light" : "dark";
  nativeTheme.themeSource = appearance;
  const channel = saved.updateChannel === "preview" || saved.updateChannel === "stable"
    ? saved.updateChannel
    : packagedRelease?.channel || "stable";
  if (channel === "preview") updater.setChannel("preview");

  registerDesktopIpc({
    ipcMain,
    dialog,
    shell,
    nativeTheme,
    credentials,
    settings,
    updater,
    getWindow: () => mainWindow,
    getAppearance: () => appearance,
    setAppearance: (value) => { appearance = value; },
  });
  mainWindow = await createWindow();
  mainWindow.on("closed", () => { mainWindow = undefined; });
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = await createWindow();
      mainWindow.on("closed", () => { mainWindow = undefined; });
    }
  });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { void credentials.close(); });
