import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerDesktopIpc } from "../desktop/main/ipc/register-ipc.mjs";
import { createSettingsStore } from "../desktop/main/services/settings-store.mjs";
import {
  createTutorialLifecycle,
  TUTORIAL_VERSION,
} from "../desktop/main/services/tutorial-lifecycle.mjs";

const directories = [];
const productContext = (overrides = {}) => ({
  surface: "product",
  providerConnected: true,
  threadCount: 0,
  ...overrides,
});

async function fixture(initial = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relayer-tutorial-"));
  directories.push(directory);
  const settings = createSettingsStore(directory);
  if (Object.keys(initial).length) await settings.write(initial);
  return { directory, settings, tutorial: createTutorialLifecycle({ settings }) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("desktop tutorial lifecycle", () => {
  it("exposes lifecycle IPC only to the product preload", async () => {
    const productPreload = await readFile(new URL("../desktop/preload/index.cjs", import.meta.url), "utf8");
    expect(productPreload).toContain("tutorial: {");
    expect(productPreload).toContain('ipcRenderer.invoke("relayer:tutorial-read", context)');
    expect(productPreload).toContain('ipcRenderer.invoke("relayer:tutorial-begin-automatic", context)');
    expect(productPreload).toContain('ipcRenderer.invoke("relayer:tutorial-begin-manual")');
    expect(productPreload).toContain('ipcRenderer.invoke("relayer:tutorial-dismiss")');
    expect(productPreload).toContain('ipcRenderer.invoke("relayer:tutorial-complete")');

    for (const name of ["eval-dashboard.cjs", "eval-review.cjs", "eval-judge.cjs", "eval-trace.cjs"]) {
      const evalPreload = await readFile(new URL(`../desktop/preload/${name}`, import.meta.url), "utf8");
      expect(evalPreload).not.toContain("relayer:tutorial");
    }
  });

  it("routes the product preload lifecycle contract through dedicated IPC handlers", async () => {
    const handlers = new Map();
    const tutorial = {
      read: async (context) => ({ method: "read", context }),
      beginAutomatic: async (context) => ({ method: "beginAutomatic", context }),
      beginManual: async () => ({ method: "beginManual" }),
      dismiss: async () => ({ method: "dismiss" }),
      complete: async () => ({ method: "complete" }),
    };
    registerDesktopIpc({
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
      dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
      shell: { openExternal: async () => {} },
      nativeTheme: {},
      credentials: { account() {}, login() {}, logout() {} },
      modelCatalog: { settingsOpened() {}, explicitRefresh() {} },
      settings: { read: async () => ({}), update: async (update) => update({}) },
      tutorial,
      updater: {
        status: () => ({ phase: "idle" }),
        check() {},
        download() {},
        install() {},
        setChannel() {},
      },
      getWindow: () => null,
      getAppearance: () => "dark",
      setAppearance() {},
    });

    const context = productContext();
    await expect(handlers.get("relayer:tutorial-read")({}, context)).resolves.toEqual({ method: "read", context });
    await expect(handlers.get("relayer:tutorial-begin-automatic")({}, context))
      .resolves.toEqual({ method: "beginAutomatic", context });
    await expect(handlers.get("relayer:tutorial-begin-manual")()).resolves.toEqual({ method: "beginManual" });
    await expect(handlers.get("relayer:tutorial-dismiss")()).resolves.toEqual({ method: "dismiss" });
    await expect(handlers.get("relayer:tutorial-complete")()).resolves.toEqual({ method: "complete" });
  });

  it("automatically starts exactly once only after connection in an empty product", async () => {
    const { tutorial } = await fixture();
    await expect(tutorial.read(productContext({ providerConnected: false }))).resolves.toEqual({
      status: "never-shown",
      automaticEligible: false,
    });
    await expect(tutorial.read(productContext({ threadCount: 1 }))).resolves.toEqual({
      status: "never-shown",
      automaticEligible: false,
    });
    await expect(tutorial.read(productContext())).resolves.toEqual({
      status: "never-shown",
      automaticEligible: true,
    });

    await expect(tutorial.beginAutomatic(productContext())).resolves.toEqual({
      status: "dismissed",
      automaticEligible: false,
      started: true,
      source: "automatic",
    });
    await expect(tutorial.beginAutomatic(productContext())).resolves.toEqual({
      status: "dismissed",
      automaticEligible: false,
      started: false,
      source: "automatic",
    });
  });

  it("keeps dismissal and completion terminal while allowing manual replay", async () => {
    const { tutorial } = await fixture();
    await expect(tutorial.dismiss()).resolves.toEqual({ status: "dismissed" });
    await expect(tutorial.beginManual()).resolves.toEqual({
      status: "dismissed",
      started: true,
      source: "manual",
    });
    await expect(tutorial.complete()).resolves.toEqual({ status: "completed" });
    await expect(tutorial.dismiss()).resolves.toEqual({ status: "completed" });
    await expect(tutorial.beginManual()).resolves.toEqual({
      status: "completed",
      started: true,
      source: "manual",
    });
  });

  it("suppresses automatic launch when a never-shown tutorial starts manually", async () => {
    const { settings, tutorial } = await fixture();

    await expect(tutorial.beginManual()).resolves.toEqual({
      status: "dismissed",
      started: true,
      source: "manual",
    });
    await expect(settings.read()).resolves.toMatchObject({
      tutorial: { version: TUTORIAL_VERSION, status: "dismissed" },
    });
  });

  it("preserves unrelated desktop settings across lifecycle changes", async () => {
    const { directory, tutorial } = await fixture({ appearance: "light", updateChannel: "preview" });
    await tutorial.beginAutomatic(productContext());
    await tutorial.complete();
    expect(JSON.parse(await readFile(join(directory, "desktop-settings.json"), "utf8"))).toEqual({
      appearance: "light",
      updateChannel: "preview",
      tutorial: { version: TUTORIAL_VERSION, status: "completed" },
    });
  });

  it("fails closed for unknown markers and rejects non-product automatic contexts", async () => {
    for (const marker of [
      null,
      "completed",
      { version: 99, status: "completed" },
      { version: TUTORIAL_VERSION, status: "unknown" },
    ]) {
      const { tutorial } = await fixture({ tutorial: marker });
      await expect(tutorial.read(productContext())).resolves.toEqual({
        status: "dismissed",
        automaticEligible: false,
      });
    }

    const { tutorial } = await fixture();
    await expect(tutorial.read({ ...productContext(), surface: "review" }))
      .rejects.toThrow("writable product surface");
    await expect(tutorial.beginAutomatic({ ...productContext(), surface: "eval" }))
      .rejects.toThrow("writable product surface");
    await expect(tutorial.read(productContext({ providerConnected: "yes" })))
      .rejects.toThrow("providerConnected must be a boolean");
    await expect(tutorial.read(productContext({ threadCount: -1 })))
      .rejects.toThrow("threadCount must be a non-negative integer");
  });

  it("serializes settings updates so concurrent features do not lose fields", async () => {
    const { settings } = await fixture();
    await Promise.all([
      settings.update((current) => ({ ...current, appearance: "light" })),
      settings.update((current) => ({ ...current, tutorial: { version: TUTORIAL_VERSION, status: "dismissed" } })),
      settings.update((current) => ({ ...current, updateChannel: "preview" })),
    ]);
    await expect(settings.read()).resolves.toEqual({
      appearance: "light",
      tutorial: { version: TUTORIAL_VERSION, status: "dismissed" },
      updateChannel: "preview",
    });
  });
});
