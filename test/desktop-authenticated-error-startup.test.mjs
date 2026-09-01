import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDesktopAccountTelemetry,
  createDesktopErrorReporterIssuer,
  GRAPHCOMPLETE_SENTRY_DSN,
  initializeDesktopAuthenticatedErrorReporting,
  setDesktopAuthenticatedErrorChannel,
} from "../desktop/main/services/authenticated-error-startup.mjs";
import { developmentTelemetryPackageMetadata } from "../desktop/shared/telemetry-release.mjs";

const directories = [];
const reportingAuthorities = [];

afterEach(async () => {
  await Promise.all(reportingAuthorities.splice(0).map((reporting) => reporting.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("desktop authenticated error startup", () => {
  it("refreshes live child capabilities after every contained account authority transition", async () => {
    const order = [];
    const reporting = {
      account: {
        transitionIdentity: vi.fn(async (identity) => order.push(identity === null ? "disable" : `enable:${identity.generation}`)),
        retireIdentity: vi.fn(async () => order.push("retire")),
      },
    };
    const refreshChildren = vi.fn(async () => order.push("refresh"));
    const telemetry = createDesktopAccountTelemetry({
      getReporting: () => reporting,
      refreshChildren,
    });

    await telemetry.transitionIdentity({ generation: 1, subject: "auth0|first" });
    await telemetry.retireIdentity();
    await telemetry.transitionIdentity({ generation: 2, subject: "auth0|replacement" });
    await telemetry.transitionIdentity(null);

    expect(order).toEqual([
      "enable:1", "refresh",
      "retire", "refresh",
      "enable:2", "refresh",
      "disable", "refresh",
    ]);
    expect(refreshChildren).toHaveBeenCalledTimes(4);
  });

  it("acquires current account authority lazily and rejects after process revocation", async () => {
    let reporting = null;
    const report = vi.fn(async () => ({ accepted: true, delivery: "sent" }));
    const revoke = vi.fn();
    const issueReporter = vi.fn(() => ({ report, revoke }));
    const issue = createDesktopErrorReporterIssuer({ getReporting: () => reporting });
    const reporter = issue("electron-main", 7);
    const record = { code: "electron_main.unhandled_crash", exceptionClass: null, frames: [] };

    await expect(reporter.report(record)).resolves.toEqual({ accepted: false, reason: "unsigned" });
    reporting = { issueReporter };
    await expect(reporter.report(record)).resolves.toEqual({ accepted: true, delivery: "sent" });
    expect(issueReporter).toHaveBeenCalledWith({ component: "electron-main", processGeneration: 7 });
    expect(revoke).toHaveBeenCalledOnce();
    reporter.revoke();
    await expect(reporter.report(record)).resolves.toEqual({ accepted: false, reason: "revoked" });
  });

  it("revokes an in-flight inner reporter when its process generation is retired", async () => {
    let releaseReport;
    const held = new Promise((resolve) => { releaseReport = resolve; });
    const inner = {
      report: vi.fn(() => held),
      revoke: vi.fn(),
    };
    const issue = createDesktopErrorReporterIssuer({
      getReporting: () => ({ issueReporter: () => inner }),
    });
    const reporter = issue("electron-main", 4);
    const reporting = reporter.report({ code: "electron_main.unhandled_crash", exceptionClass: null, frames: [] });
    await vi.waitFor(() => expect(inner.report).toHaveBeenCalledOnce());

    reporter.revoke();
    expect(inner.revoke).toHaveBeenCalledOnce();
    releaseReport({ accepted: false, reason: "stale-capability" });
    await reporting;
  });

  it("routes non-main component adapters through the production loopback capability", async () => {
    const revoke = vi.fn();
    const issueCapability = vi.fn(() => ({
      endpoint: "http://127.0.0.1:43129/v1/authenticated-errors/report",
      authorization: "Bearer process-capability",
      revoke,
    }));
    const fetchImpl = vi.fn(async () => ({ json: async () => ({ accepted: true }) }));
    const issue = createDesktopErrorReporterIssuer({
      getReporting: () => ({ issueCapability }),
      fetchImpl,
    });
    const reporter = issue("rust-app-server", 9);
    const record = { code: "rust_app_server.unexpected_exit", exceptionClass: null, frames: [] };

    await expect(reporter.report(record)).resolves.toEqual({ accepted: true, delivery: "submitted" });
    expect(issueCapability).toHaveBeenCalledWith({ component: "rust-app-server", processGeneration: 9 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:43129/v1/authenticated-errors/report",
      {
        method: "POST",
        headers: {
          authorization: "Bearer process-capability",
          "content-type": "application/json",
        },
        body: JSON.stringify(record),
      },
    );
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("composes the project DSN, development release, and safeStorage-encrypted queue", async () => {
    expect(GRAPHCOMPLETE_SENTRY_DSN).toBe(
      "https://8c71bc3ff03f651ce765029091edac1e@o4510780407414784.ingest.us.sentry.io/4511989779988480",
    );
    const userDataPath = await mkdtemp(join(tmpdir(), "relayer-telemetry-startup-"));
    directories.push(userDataPath);
    const encryptString = vi.fn((value) => Buffer.from(`sealed:${value}`));
    const decryptString = vi.fn((value) => value.toString("utf8").replace(/^sealed:/u, ""));
    const transport = {
      enable: vi.fn(async () => {}),
      disable: vi.fn(async () => {}),
      send: vi.fn(async () => { throw new Error("capture sink unavailable"); }),
    };
    const createTransport = vi.fn(() => transport);

    const reporting = await initializeDesktopAuthenticatedErrorReporting({
      userDataPath,
      packageMetadata: {
        version: "0.2.16",
        relayerArtifactMode: "development",
        relayerProductName: "Relayer Dev",
      },
      appVersion: "0.2.16",
      platform: "darwin",
      architecture: "arm64",
      currentUpdateChannel: "development",
      safeStorage: { isEncryptionAvailable: () => true, encryptString, decryptString },
      createTransport,
    });
    reportingAuthorities.push(reporting);

    expect(createTransport).toHaveBeenCalledWith({ dsn: GRAPHCOMPLETE_SENTRY_DSN });
    await reporting.account.transitionIdentity({ generation: 1, subject: "auth0|startup-person" });
    const reporter = reporting.issueReporter({ component: "electron-main", processGeneration: 1 });
    await expect(reporter.report({
      code: "electron_main.unhandled_crash",
      exceptionClass: null,
      frames: [],
    })).resolves.toEqual({ accepted: true, delivery: "queued" });
    expect(encryptString).toHaveBeenCalledOnce();
    expect(decryptString).not.toHaveBeenCalled();
  });

  it("returns no authority when setup fails and does not expose the failure to product startup", async () => {
    const onUnavailable = vi.fn();
    const createTransport = vi.fn(async () => { throw new Error("Sentry SDK failed to initialize"); });

    await expect(initializeDesktopAuthenticatedErrorReporting({
      userDataPath: "/unused",
      packageMetadata: {
        version: "0.2.16",
        relayerArtifactMode: "development",
        relayerProductName: "Relayer Dev",
      },
      appVersion: "0.2.16",
      platform: "darwin",
      architecture: "arm64",
      currentUpdateChannel: "development",
      safeStorage: {},
      createTransport,
      onUnavailable,
    })).resolves.toBeNull();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith();
    expect(createTransport).toHaveBeenCalledWith({ dsn: GRAPHCOMPLETE_SENTRY_DSN });
  });

  it("initializes Linux development reporting with the normalized product version", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "relayer-telemetry-linux-"));
    directories.push(userDataPath);
    const encryptString = vi.fn((value) => Buffer.from(`sealed:${value}`));
    const decryptString = vi.fn((value) => value.toString("utf8").replace(/^sealed:/u, ""));
    const transport = {
      enable: vi.fn(async () => {}),
      disable: vi.fn(async () => {}),
      send: vi.fn(async () => { throw new Error("capture sink unavailable"); }),
    };

    const reporting = await initializeDesktopAuthenticatedErrorReporting({
      userDataPath,
      packageMetadata: developmentTelemetryPackageMetadata("0.2.16"),
      appVersion: "0.2.16",
      platform: "linux",
      architecture: "x64",
      currentUpdateChannel: "development",
      safeStorage: { isEncryptionAvailable: () => true, encryptString, decryptString },
      createTransport: () => transport,
    });
    reportingAuthorities.push(reporting);

    expect(reporting).not.toBeNull();
    await reporting.account.transitionIdentity({ generation: 1, subject: "auth0|linux-dev" });
    const reporter = reporting.issueReporter({ component: "electron-main", processGeneration: 1 });
    await expect(reporter.report({
      code: "electron_main.unhandled_crash",
      exceptionClass: null,
      frames: [],
    })).resolves.toEqual({ accepted: true, delivery: "queued" });
  });

  it("returns no authority when Electron's unsigned Linux version is supplied", async () => {
    const onUnavailable = vi.fn();

    await expect(initializeDesktopAuthenticatedErrorReporting({
      userDataPath: "/unused",
      packageMetadata: developmentTelemetryPackageMetadata("0.0"),
      appVersion: "0.0",
      platform: "linux",
      architecture: "x64",
      currentUpdateChannel: "development",
      safeStorage: { isEncryptionAvailable: () => true, encryptString: vi.fn(), decryptString: vi.fn() },
      createTransport: vi.fn(),
      onUnavailable,
    })).resolves.toBeNull();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it("rotates packaged telemetry before the account channel and contains telemetry failure", async () => {
    const order = [];
    const reporting = {
      updateEnvironment: vi.fn(async () => {
        order.push("telemetry");
        throw new Error("transport rotation failed");
      }),
    };
    const account = {
      setChannel: vi.fn(async (channel) => {
        order.push(`account:${channel}`);
        return { status: "signed-out", channel };
      }),
    };

    await expect(setDesktopAuthenticatedErrorChannel({
      reporting,
      account,
      releaseArtifact: true,
      channel: "stable",
    })).resolves.toEqual({ status: "signed-out", channel: "stable" });
    expect(order).toEqual(["telemetry", "account:stable"]);
  });
});
