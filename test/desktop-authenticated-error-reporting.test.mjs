import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDesktopAuthenticatedErrorReporting } from "../desktop/main/services/authenticated-error-reporting.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function transportFixture() {
  return {
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
  };
}

const releaseIdentity = Object.freeze({
  release: "ai.relayer.desktop@0.2.16+fixture",
  environment: "preview",
  os: "macos",
  architecture: "arm64",
});

function base64Encrypt() {
  return {
    encrypt: async (value) => Buffer.from(value).toString("base64"),
    decrypt: async (value) => Buffer.from(value, "base64").toString("utf8"),
  };
}

describe("desktop authenticated error reporting composition", () => {
  it("gates authority on account verification, survives receiver bind failure, and closes all authority together", async () => {
    const directory = await mkdtemp(join(tmpdir(), "relayer-error-reporting-"));
    directories.push(directory);
    const queuePath = join(directory, "queue.json");
    const transport = transportFixture();

    const reporting = await createDesktopAuthenticatedErrorReporting({
      queuePath,
      ...base64Encrypt(),
      transport,
      releaseIdentity,
    });

    expect(reporting.issueReporter({ component: "electron-main", processGeneration: 1 }),
      "no reporter authority before account verification").toBeNull();
    expect(reporting.issueCapability({ component: "rust-app-server", processGeneration: 1 }),
      "no loopback capability before account verification").toBeNull();
    expect(transport.enable, "transport stays disabled before account verification").not.toHaveBeenCalled();

    await reporting.account.transitionIdentity({ generation: 1, subject: "auth0|person" });
    expect(transport.enable, "account verification enables transport exactly once").toHaveBeenCalledOnce();
    expect(reporting.issueReporter({ component: "electron-main", processGeneration: 1 }),
      "verification issues main-process reporter authority").not.toBeNull();
    const capability = reporting.issueCapability({ component: "rust-app-server", processGeneration: 1 });
    expect(capability.endpoint, "verification issues a loopback capability").toMatch(/^http:\/\/127\.0\.0\.1:/u);

    await reporting.account.retireIdentity();
    expect(reporting.issueReporter({ component: "electron-main", processGeneration: 2 }),
      "retirement nulls reporter authority").toBeNull();
    expect(reporting.issueCapability({ component: "rust-app-server", processGeneration: 2 }),
      "retirement nulls capability authority").toBeNull();
    await reporting.close();
    expect(transport.disable, "close disables transport").toHaveBeenCalled();

    const bindFailureTransport = transportFixture();
    const degraded = await createDesktopAuthenticatedErrorReporting({
      queuePath,
      ...base64Encrypt(),
      transport: bindFailureTransport,
      releaseIdentity,
      createReceiver: async () => { throw new Error("bind unavailable"); },
    });
    await degraded.account.transitionIdentity({ generation: 1, subject: "auth0|person" });
    expect(degraded.issueReporter({ component: "electron-main", processGeneration: 1 }),
      "receiver bind failure keeps main-process reporting available").not.toBeNull();
    expect(degraded.issueCapability({ component: "rust-app-server", processGeneration: 1 }),
      "receiver bind failure nulls the loopback capability").toBeNull();
    await degraded.close();
  }, 15_000);
});
