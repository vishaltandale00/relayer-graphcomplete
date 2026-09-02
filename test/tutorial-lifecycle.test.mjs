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
  it("exposes and routes the tutorial lifecycle only through product preload IPC", async () => {
    const productPreload = await readFile(new URL("../desktop/preload/index.cjs", import.meta.url), "utf8");
    expect(productPreload, "product preload exposes the tutorial namespace").toContain("tutorial: {");
    expect(productPreload, "read channel").toContain('ipcRenderer.invoke("relayer:tutorial-read", context)');
    expect(productPreload, "begin-automatic channel").toContain('ipcRenderer.invoke("relayer:tutorial-begin-automatic", context)');
    expect(productPreload, "begin-manual channel").toContain('ipcRenderer.invoke("relayer:tutorial-begin-manual")');
    expect(productPreload, "dismiss channel").toContain('ipcRenderer.invoke("relayer:tutorial-dismiss")');
    expect(productPreload, "complete channel").toContain('ipcRenderer.invoke("relayer:tutorial-complete")');

    for (const name of ["eval-dashboard.cjs", "eval-review.cjs", "eval-judge.cjs", "eval-trace.cjs"]) {
      const evalPreload = await readFile(new URL(`../desktop/preload/${name}`, import.meta.url), "utf8");
      expect(evalPreload, `${name} stays free of tutorial IPC`).not.toContain("relayer:tutorial");
    }

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
    await expect(handlers.get("relayer:tutorial-read")({}, context), "read routed with context")
      .resolves.toEqual({ method: "read", context });
    await expect(handlers.get("relayer:tutorial-begin-automatic")({}, context), "begin-automatic routed with context")
      .resolves.toEqual({ method: "beginAutomatic", context });
    await expect(handlers.get("relayer:tutorial-begin-manual")(), "begin-manual routed")
      .resolves.toEqual({ method: "beginManual" });
    await expect(handlers.get("relayer:tutorial-dismiss")(), "dismiss routed")
      .resolves.toEqual({ method: "dismiss" });
    await expect(handlers.get("relayer:tutorial-complete")(), "complete routed")
      .resolves.toEqual({ method: "complete" });
  });

  it("walks the tutorial lifecycle state machine with durable, fail-closed settings", async () => {
    const gated = await fixture();
    await expect(
      gated.tutorial.read(productContext({ providerConnected: false })),
      "disconnected provider is ineligible",
    ).resolves.toEqual({ status: "never-shown", automaticEligible: false });
    await expect(
      gated.tutorial.read(productContext({ threadCount: 1 })),
      "non-empty product is ineligible",
    ).resolves.toEqual({ status: "never-shown", automaticEligible: false });
    await expect(
      gated.tutorial.read(productContext()),
      "connected empty product is eligible",
    ).resolves.toEqual({ status: "never-shown", automaticEligible: true });

    await expect(
      gated.tutorial.beginAutomatic(productContext()),
      "first automatic begin starts",
    ).resolves.toEqual({
      status: "dismissed",
      automaticEligible: false,
      started: true,
      source: "automatic",
    });
    await expect(
      gated.tutorial.beginAutomatic(productContext()),
      "second automatic begin is a no-op",
    ).resolves.toEqual({
      status: "dismissed",
      automaticEligible: false,
      started: false,
      source: "automatic",
    });

    const terminal = await fixture();
    await expect(terminal.tutorial.dismiss(), "dismiss records dismissal").resolves.toEqual({ status: "dismissed" });
    await expect(terminal.tutorial.beginManual(), "manual replay after dismissal").resolves.toEqual({
      status: "dismissed",
      started: true,
      source: "manual",
    });
    await expect(terminal.tutorial.complete(), "completion is recorded").resolves.toEqual({ status: "completed" });
    await expect(terminal.tutorial.dismiss(), "dismissal after completion stays completed")
      .resolves.toEqual({ status: "completed" });
    await expect(terminal.tutorial.beginManual(), "manual replay after completion").resolves.toEqual({
      status: "completed",
      started: true,
      source: "manual",
    });

    const manualFirst = await fixture();
    await expect(manualFirst.tutorial.beginManual(), "manual start on a never-shown tutorial")
      .resolves.toEqual({ status: "dismissed", started: true, source: "manual" });
    await expect(manualFirst.settings.read(), "manual start suppresses automatic launch").resolves
      .toMatchObject({ tutorial: { version: TUTORIAL_VERSION, status: "dismissed" } });

    const preserved = await fixture({ appearance: "light", updateChannel: "preview" });
    await preserved.tutorial.beginAutomatic(productContext());
    await preserved.tutorial.complete();
    expect(
      JSON.parse(await readFile(join(preserved.directory, "desktop-settings.json"), "utf8")),
      "unrelated settings survive lifecycle changes",
    ).toEqual({
      appearance: "light",
      updateChannel: "preview",
      tutorial: { version: TUTORIAL_VERSION, status: "completed" },
    });

    for (const marker of [
      null,
      "completed",
      { version: 99, status: "completed" },
      { version: TUTORIAL_VERSION, status: "unknown" },
    ]) {
      const { tutorial } = await fixture({ tutorial: marker });
      await expect(
        tutorial.read(productContext()),
        `unknown marker ${JSON.stringify(marker)} fails closed`,
      ).resolves.toEqual({ status: "dismissed", automaticEligible: false });
    }

    const invalid = await fixture();
    await expect(invalid.tutorial.read({ ...productContext(), surface: "review" }), "non-product read rejected")
      .rejects.toThrow("writable product surface");
    await expect(invalid.tutorial.beginAutomatic({ ...productContext(), surface: "eval" }), "non-product begin rejected")
      .rejects.toThrow("writable product surface");
    await expect(invalid.tutorial.read(productContext({ providerConnected: "yes" })), "providerConnected type enforced")
      .rejects.toThrow("providerConnected must be a boolean");
    await expect(invalid.tutorial.read(productContext({ threadCount: -1 })), "threadCount range enforced")
      .rejects.toThrow("threadCount must be a non-negative integer");

    const concurrent = await fixture();
    await Promise.all([
      concurrent.settings.update((current) => ({ ...current, appearance: "light" })),
      concurrent.settings.update((current) => ({ ...current, tutorial: { version: TUTORIAL_VERSION, status: "dismissed" } })),
      concurrent.settings.update((current) => ({ ...current, updateChannel: "preview" })),
    ]);
    await expect(concurrent.settings.read(), "concurrent updates keep every field").resolves.toEqual({
      appearance: "light",
      tutorial: { version: TUTORIAL_VERSION, status: "dismissed" },
      updateChannel: "preview",
    });
  }, 15_000);
});
