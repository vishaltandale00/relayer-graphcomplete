import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDesktopAuthenticatedErrorReporting } from "../desktop/main/services/authenticated-error-reporting.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("desktop authenticated error reporting composition", () => {
  it("keeps transport and capabilities unavailable until account verification and closes all authority together", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-error-reporting-"));
    directories.push(directory);
    const transport = {
      enable: vi.fn(async () => {}),
      disable: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const reporting = await createDesktopAuthenticatedErrorReporting({
      queuePath: join(directory, "queue.json"),
      encrypt: async (value) => Buffer.from(value).toString("base64"),
      decrypt: async (value) => Buffer.from(value, "base64").toString("utf8"),
      transport,
      releaseIdentity: {
        release: "ai.relayer.desktop@0.2.16+fixture",
        environment: "preview",
        os: "macos",
        architecture: "arm64",
      },
    });

    expect(reporting.issueReporter({ component: "electron-main", processGeneration: 1 })).toBeNull();
    expect(reporting.issueCapability({ component: "rust-app-server", processGeneration: 1 })).toBeNull();
    expect(transport.enable).not.toHaveBeenCalled();

    await reporting.account.transitionIdentity({ generation: 1, subject: "auth0|person" });
    expect(transport.enable).toHaveBeenCalledOnce();
    expect(reporting.issueReporter({ component: "electron-main", processGeneration: 1 })).not.toBeNull();
    const capability = reporting.issueCapability({ component: "rust-app-server", processGeneration: 1 });
    expect(capability.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:/u);

    await reporting.account.retireIdentity();
    expect(reporting.issueReporter({ component: "electron-main", processGeneration: 2 })).toBeNull();
    await reporting.close();
    expect(transport.disable).toHaveBeenCalled();
  });

  it("keeps main-process reporting available when the local capability receiver cannot bind", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-error-reporting-"));
    directories.push(directory);
    const transport = {
      enable: vi.fn(async () => {}),
      disable: vi.fn(async () => {}),
      send: vi.fn(async () => {}),
    };
    const reporting = await createDesktopAuthenticatedErrorReporting({
      queuePath: join(directory, "queue.json"),
      encrypt: async (value) => Buffer.from(value).toString("base64"),
      decrypt: async (value) => Buffer.from(value, "base64").toString("utf8"),
      transport,
      releaseIdentity: {
        release: "ai.relayer.desktop@0.2.16+fixture",
        environment: "preview",
        os: "macos",
        architecture: "arm64",
      },
      createReceiver: async () => { throw new Error("bind unavailable"); },
    });

    await reporting.account.transitionIdentity({ generation: 1, subject: "auth0|person" });
    expect(reporting.issueReporter({ component: "electron-main", processGeneration: 1 })).not.toBeNull();
    expect(reporting.issueCapability({ component: "rust-app-server", processGeneration: 1 })).toBeNull();
    await reporting.close();
  });
});
