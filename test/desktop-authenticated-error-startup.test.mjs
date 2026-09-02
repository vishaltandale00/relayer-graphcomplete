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

function queueingTransportFixture() {
  return {
    enable: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    send: vi.fn(async () => { throw new Error("capture sink unavailable"); }),
  };
}

describe("desktop authenticated error startup", () => {
  it("composes startup authority and routes reports through the loopback capability", async () => {
    let reporting = null;
    const report = vi.fn(async () => ({ accepted: true, delivery: "sent" }));
    const revoke = vi.fn();
    const issueReporter = vi.fn(() => ({ report, revoke }));
    const issue = createDesktopErrorReporterIssuer({ getReporting: () => reporting });
    const lazyReporter = issue("electron-main", 7);
    const mainRecord = { code: "electron_main.unhandled_crash", exceptionClass: null, frames: [] };

    await expect(lazyReporter.report(mainRecord),
      "reporter authority stays unsigned before reporting exists").resolves.toEqual({ accepted: false, reason: "unsigned" });
    reporting = { issueReporter };
    await expect(lazyReporter.report(mainRecord),
      "reporter authority authorizes once reporting exists").resolves.toEqual({ accepted: true, delivery: "sent" });
    expect(issueReporter, "issuer acquires the current reporter per report").toHaveBeenCalledWith({ component: "electron-main", processGeneration: 7 });
    expect(revoke, "one-shot reporter is released after each report").toHaveBeenCalledOnce();
    lazyReporter.revoke();
    await expect(lazyReporter.report(mainRecord),
      "revoked reporter authority rejects").resolves.toEqual({ accepted: false, reason: "revoked" });

    let releaseReport;
    const held = new Promise((resolve) => { releaseReport = resolve; });
    const inner = { report: vi.fn(() => held), revoke: vi.fn() };
    const inFlightIssue = createDesktopErrorReporterIssuer({
      getReporting: () => ({ issueReporter: () => inner }),
    });
    const inFlightReporter = inFlightIssue("electron-main", 4);
    const inFlightResult = inFlightReporter.report(mainRecord);
    await vi.waitFor(() => expect(inner.report, "in-flight report reaches the inner reporter").toHaveBeenCalledOnce());
    inFlightReporter.revoke();
    expect(inner.revoke, "generation retirement revokes the in-flight inner reporter").toHaveBeenCalledOnce();
    releaseReport({ accepted: false, reason: "stale-capability" });
    await expect(inFlightResult, "in-flight report settles with the inner result after revocation")
      .resolves.toEqual({ accepted: false, reason: "stale-capability" });

    const capabilityRevoke = vi.fn();
    const issueCapability = vi.fn(() => ({
      endpoint: "http://127.0.0.1:43129/v1/authenticated-errors/report",
      authorization: "Bearer process-capability",
      revoke: capabilityRevoke,
    }));
    const fetchImpl = vi.fn(async () => ({ json: async () => ({ accepted: true }) }));
    const capabilityIssue = createDesktopErrorReporterIssuer({
      getReporting: () => ({ issueCapability }),
      fetchImpl,
    });
    const capabilityReporter = capabilityIssue("rust-app-server", 9);
    const childRecord = { code: "rust_app_server.unexpected_exit", exceptionClass: null, frames: [] };

    await expect(capabilityReporter.report(childRecord),
      "non-main components submit through the loopback capability").resolves.toEqual({ accepted: true, delivery: "submitted" });
    expect(issueCapability, "issuer fetches the component loopback capability").toHaveBeenCalledWith({ component: "rust-app-server", processGeneration: 9 });
    expect(fetchImpl, "capability fetch posts the record with bearer authorization").toHaveBeenCalledWith(
      "http://127.0.0.1:43129/v1/authenticated-errors/report",
      {
        method: "POST",
        headers: {
          authorization: "Bearer process-capability",
          "content-type": "application/json",
        },
        body: JSON.stringify(childRecord),
      },
    );
    expect(capabilityRevoke, "loopback capability is released after each report").toHaveBeenCalledOnce();

    expect(GRAPHCOMPLETE_SENTRY_DSN, "project DSN is pinned").toBe(
      "https://8c71bc3ff03f651ce765029091edac1e@o4510780407414784.ingest.us.sentry.io/4511989779988480",
    );
    const userDataPath = await mkdtemp(join(tmpdir(), "relayer-telemetry-startup-"));
    directories.push(userDataPath);
    const encryptString = vi.fn((value) => Buffer.from(`sealed:${value}`));
    const decryptString = vi.fn((value) => value.toString("utf8").replace(/^sealed:/u, ""));
    const transport = queueingTransportFixture();
    const createTransport = vi.fn(() => transport);

    const initialized = await initializeDesktopAuthenticatedErrorReporting({
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
    reportingAuthorities.push(initialized);

    expect(createTransport, "startup transport receives the project DSN").toHaveBeenCalledWith({ dsn: GRAPHCOMPLETE_SENTRY_DSN });
    await initialized.account.transitionIdentity({ generation: 1, subject: "auth0|startup-person" });
    const startupReporter = initialized.issueReporter({ component: "electron-main", processGeneration: 1 });
    await expect(startupReporter.report({
      code: "electron_main.unhandled_crash",
      exceptionClass: null,
      frames: [],
    }), "development transport failure queues under safeStorage encryption").resolves.toEqual({ accepted: true, delivery: "queued" });
    expect(encryptString, "queued record is sealed with safeStorage encryption").toHaveBeenCalledOnce();
    expect(decryptString, "queue write never decrypts").not.toHaveBeenCalled();

    const linuxUserDataPath = await mkdtemp(join(tmpdir(), "relayer-telemetry-linux-"));
    directories.push(linuxUserDataPath);
    const linuxEncryptString = vi.fn((value) => Buffer.from(`sealed:${value}`));
    const linuxDecryptString = vi.fn((value) => value.toString("utf8").replace(/^sealed:/u, ""));

    const linuxReporting = await initializeDesktopAuthenticatedErrorReporting({
      userDataPath: linuxUserDataPath,
      packageMetadata: developmentTelemetryPackageMetadata("0.2.16"),
      appVersion: "0.2.16",
      platform: "linux",
      architecture: "x64",
      currentUpdateChannel: "development",
      safeStorage: { isEncryptionAvailable: () => true, encryptString: linuxEncryptString, decryptString: linuxDecryptString },
      createTransport: () => queueingTransportFixture(),
    });
    reportingAuthorities.push(linuxReporting);

    expect(linuxReporting, "Linux development reporting initializes with the normalized product version").not.toBeNull();
    await linuxReporting.account.transitionIdentity({ generation: 1, subject: "auth0|linux-dev" });
    const linuxReporter = linuxReporting.issueReporter({ component: "electron-main", processGeneration: 1 });
    await expect(linuxReporter.report({
      code: "electron_main.unhandled_crash",
      exceptionClass: null,
      frames: [],
    }), "Linux development queues encrypted records the same way").resolves.toEqual({ accepted: true, delivery: "queued" });
    expect(linuxEncryptString, "Linux queue record is sealed with safeStorage encryption").toHaveBeenCalledOnce();
    expect(linuxDecryptString, "Linux queue write never decrypts").not.toHaveBeenCalled();
  }, 20_000);

  it("contains setup failure and rotates the error channel", async () => {
    const onUnavailable = vi.fn();
    const failingCreateTransport = vi.fn(async () => { throw new Error("Sentry SDK failed to initialize"); });

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
      createTransport: failingCreateTransport,
      onUnavailable,
    }), "transport setup failure returns no authority").resolves.toBeNull();
    expect(onUnavailable, "transport setup failure reports unavailability exactly once").toHaveBeenCalledOnce();
    expect(onUnavailable, "unavailability callback carries no error detail").toHaveBeenCalledWith();
    expect(failingCreateTransport, "transport setup still receives the project DSN").toHaveBeenCalledWith({ dsn: GRAPHCOMPLETE_SENTRY_DSN });

    const unsignedOnUnavailable = vi.fn();
    await expect(initializeDesktopAuthenticatedErrorReporting({
      userDataPath: "/unused",
      packageMetadata: developmentTelemetryPackageMetadata("0.0"),
      appVersion: "0.0",
      platform: "linux",
      architecture: "x64",
      currentUpdateChannel: "development",
      safeStorage: { isEncryptionAvailable: () => true, encryptString: vi.fn(), decryptString: vi.fn() },
      createTransport: vi.fn(),
      onUnavailable: unsignedOnUnavailable,
    }), "unsigned Linux version returns no authority").resolves.toBeNull();
    expect(unsignedOnUnavailable, "unsigned Linux reports unavailability exactly once").toHaveBeenCalledOnce();

    const rotationOrder = [];
    const rotationReporting = {
      updateEnvironment: vi.fn(async () => {
        rotationOrder.push("telemetry");
        throw new Error("transport rotation failed");
      }),
    };
    const rotationAccount = {
      setChannel: vi.fn(async (channel) => {
        rotationOrder.push(`account:${channel}`);
        return { status: "signed-out", channel };
      }),
    };

    await expect(setDesktopAuthenticatedErrorChannel({
      reporting: rotationReporting,
      account: rotationAccount,
      releaseArtifact: true,
      channel: "stable",
    }), "channel rotation settles the account result despite telemetry failure").resolves.toEqual({ status: "signed-out", channel: "stable" });
    expect(rotationOrder, "packaged telemetry rotates before the account channel and its failure is contained")
      .toEqual(["telemetry", "account:stable"]);

    const transitionOrder = [];
    const transitionReporting = {
      account: {
        transitionIdentity: vi.fn(async (identity) => transitionOrder.push(identity === null ? "disable" : `enable:${identity.generation}`)),
        retireIdentity: vi.fn(async () => transitionOrder.push("retire")),
      },
    };
    const refreshChildren = vi.fn(async () => transitionOrder.push("refresh"));
    const telemetry = createDesktopAccountTelemetry({
      getReporting: () => transitionReporting,
      refreshChildren,
    });

    await telemetry.transitionIdentity({ generation: 1, subject: "auth0|first" });
    await telemetry.retireIdentity();
    await telemetry.transitionIdentity({ generation: 2, subject: "auth0|replacement" });
    await telemetry.transitionIdentity(null);

    expect(transitionOrder, "every contained account transition projects before refreshing child capabilities").toEqual([
      "enable:1", "refresh",
      "retire", "refresh",
      "enable:2", "refresh",
      "disable", "refresh",
    ]);
    expect(refreshChildren, "child capabilities refresh after every transition").toHaveBeenCalledTimes(4);
  }, 15_000);
});
