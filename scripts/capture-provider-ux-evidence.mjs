import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { app, BrowserWindow, ipcMain } from "electron";

const repositoryRoot = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[process.argv.indexOf("--output") + 1] ?? "provider-ux.png");
const scenario = process.argv[process.argv.indexOf("--scenario") + 1] ?? "onboarding";
const theme = process.argv[process.argv.indexOf("--theme") + 1] === "light" ? "light" : "dark";
const narrow = process.argv.includes("--narrow");

const adapters = [
  ["codex-subscription", "Codex subscription", "managed-login"],
  ["claude-subscription", "Claude subscription", "managed-login"],
  ["openai-api", "OpenAI API", "secret-fields"],
  ["anthropic-api", "Anthropic API", "secret-fields"],
  ["openrouter", "OpenRouter", "secret-fields"],
  ["vercel-ai-router", "Vercel AI Router", "secret-fields"],
].map(([adapterId, label, mode]) => ({
  adapterId,
  implementationVersion: "fixture",
  label,
  accessContract: mode === "secret-fields" ? "secret@1" : "managed-runtime@1",
  defaultEndpoint: mode === "secret-fields" ? `https://${adapterId}.fixture.invalid/v1` : null,
  endpointEditableDuringCreation: mode === "secret-fields",
  connection: { mode, fields: mode === "secret-fields" ? [{ id: "api-key", label: "API key", kind: "secret", required: true }] : [] },
}));

const definitions = [
  { id: "work", adapterId: "openai-api", label: "OpenAI Work — North America Platform Engineering", endpoint: "https://api.openai.com/v1", accessContract: "secret@1", lifecycleState: "active" },
  { id: "personal", adapterId: "openai-api", label: "OpenAI Personal", endpoint: "https://api.openai.com/v1", accessContract: "secret@1", lifecycleState: "active" },
  { id: "anthropic", adapterId: "anthropic-api", label: "Anthropic Work", endpoint: "https://api.anthropic.com/v1", accessContract: "secret@1", lifecycleState: "removal_pending" },
];

function registerFixtures() {
  const handle = (name, value) => ipcMain.handle(name, async () => typeof value === "function" ? value() : value);
  handle("relayer:provider-status", {
    adapters,
    definitions: scenario === "onboarding" || scenario === "error" ? [] : definitions,
    hasCompletedOnboarding: !["onboarding", "error"].includes(scenario),
  });
  handle("relayer:provider-connect", () => { throw new Error("The fixture API key was rejected."); });
  handle("relayer:provider-connect-cancel", { cancelled: true });
  handle("relayer:provider-rename", definitions[0]);
  handle("relayer:provider-remove", definitions[2]);
  handle("relayer:provider-onboarding-complete", { hasCompletedOnboarding: true });
  handle("relayer:account-read", { status: "disconnected" });
  handle("relayer:appearance-read", { appearance: theme });
  handle("relayer:appearance-set", { appearance: theme });
  handle("relayer:update-status", { phase: "idle", channel: "stable", currentVersion: "fixture" });
  handle("relayer:update-check", { phase: "idle", channel: "stable", currentVersion: "fixture" });
  handle("relayer:folder-choose", null);
  handle("relayer:model-catalog-settings-open", {});
}

await app.whenReady();
process.stdout.write("fixture:ready\n");
registerFixtures();
const window = new BrowserWindow({
  show: false,
  width: narrow ? 620 : 1160,
  height: 760,
  backgroundColor: theme === "light" ? "#fafafa" : "#0b0c0d",
  webPreferences: {
    preload: resolve(repositoryRoot, "desktop/preload/index.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
  },
});
await window.loadFile(resolve(repositoryRoot, "desktop/renderer/index.html"));
process.stdout.write("fixture:loaded\n");
await window.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 250))`);
if (scenario === "error") {
  await window.webContents.executeJavaScript(`document.querySelector('[data-provider-adapter="openai-api"]').click(); document.querySelector('#providerField-label').value='OpenAI Work'; document.querySelector('#providerField-endpoint').value='not a url'; document.querySelector('#providerSetupForm').requestSubmit();`);
  await window.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 100))`);
}
if (scenario === "settings") {
  await window.webContents.executeJavaScript(`document.querySelector('#settingsButton').click(); document.querySelector('[data-settings-tab="providers"]').click();`);
  await window.webContents.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 100))`);
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, (await window.webContents.capturePage()).toPNG());
process.stdout.write(`fixture:captured:${output}\n`);
await window.close();
app.quit();
