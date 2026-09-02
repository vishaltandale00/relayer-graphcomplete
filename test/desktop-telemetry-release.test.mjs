import { describe, expect, it } from "vitest";

import {
  developmentTelemetryPackageMetadata,
  projectDesktopTelemetryRelease,
} from "../desktop/shared/telemetry-release.mjs";
import { DESKTOP_UPDATE_BASE_URLS } from "../desktop/shared/release-metadata.mjs";
import { desktopTarget, desktopTargetFromEnvironment, developmentDesktopHost, targetForElectronBuilder } from "../desktop/shared/target.mjs";

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";

function packagedMetadata(overrides = {}) {
  return {
    version: "0.2.16",
    relayerArtifactMode: "release",
    relayerProductName: "Relayer",
    relayerUpdateChannel: "preview",
    relayerUpdateBaseUrl: DESKTOP_UPDATE_BASE_URLS["macos-arm64"],
    relayerReleaseTarget: "macos-arm64",
    relayerReleasePlatform: "macos",
    relayerReleaseArchitecture: "arm64",
    relayerReleaseSourceCommit: sourceCommit,
    ...overrides,
  };
}

function project(overrides = {}) {
  return projectDesktopTelemetryRelease({
    packageMetadata: packagedMetadata(),
    appVersion: "0.2.16",
    platform: "darwin",
    architecture: "arm64",
    currentUpdateChannel: "preview",
    ...overrides,
  });
}

describe("desktop telemetry release projection", () => {
  it("projects immutable release identities for packaged, development, and Linux development builds", () => {
    const preview = project();
    const stable = project({ currentUpdateChannel: "stable" });

    expect(preview, "packaged Preview identity").toEqual({
      release: `ai.relayer.desktop@0.2.16+${sourceCommit}`,
      environment: "preview",
      os: "macos",
      architecture: "arm64",
    });
    expect(stable, "Stable keeps the packaged candidate's immutable release").toEqual({ ...preview, environment: "stable" });
    expect(stable.release, "channel rotation never changes the release").toBe(preview.release);
    expect(Object.isFrozen(preview) && Object.isFrozen(stable), "projections frozen").toBe(true);

    expect(projectDesktopTelemetryRelease({
      packageMetadata: developmentTelemetryPackageMetadata("0.2.16"),
      appVersion: "0.2.16",
      platform: "darwin",
      architecture: "arm64",
      currentUpdateChannel: "development",
    }), "development identity admits no release metadata").toEqual({
      release: "ai.relayer.desktop.development@0.2.16",
      environment: "development",
      os: "macos",
      architecture: "arm64",
    });

    expect(developmentDesktopHost({ platform: "linux", architecture: "x64" }), "Linux development host exists")
      .toMatchObject({ key: "linux-x64", distributionPlatform: "linux", architecture: "x64" });
    expect(projectDesktopTelemetryRelease({
      packageMetadata: developmentTelemetryPackageMetadata("0.2.16"),
      appVersion: "0.2.16",
      platform: "linux",
      architecture: "x64",
      currentUpdateChannel: "development",
    }), "linux-x64 development identity without admitting Linux as a signed-release target").toEqual({
      release: "ai.relayer.desktop.development@0.2.16",
      environment: "development",
      os: "linux",
      architecture: "x64",
    });
  });

  it("rejects the complete forged or unsupported release projection corpus", () => {
    expect(() => desktopTarget({ platform: "linux", architecture: "x64" }), "Linux is not a signed-release target")
      .toThrow("Unsupported Relayer Desktop target: linux-x64.");
    expect(() => desktopTargetFromEnvironment({ RELAYER_DESKTOP_TARGET: "linux-x64" }), "Linux rejected from environment selection")
      .toThrow("Unsupported Relayer Desktop release target: linux-x64.");
    expect(() => targetForElectronBuilder({ platform: "linux", architecture: "x64" }), "Linux rejected from electron-builder")
      .toThrow("Unsupported Relayer Desktop target: linux-x64.");

    const cases = [
      ["caller release override", { release: "attacker@9.9.9" }],
      ["caller environment override", { environment: "stable" }],
      ["version mismatch", { packageMetadata: packagedMetadata({ version: "0.2.15" }) }],
      ["invalid source commit", { packageMetadata: packagedMetadata({ relayerReleaseSourceCommit: "main" }) }],
      ["wrong runtime architecture", { architecture: "x64" }],
      ["Stable-authored package ambiguity", { packageMetadata: packagedMetadata({ relayerUpdateChannel: "stable" }) }],
      ["invalid current channel", { currentUpdateChannel: "beta" }],
    ];
    expect(cases, "projection rejection inventory").toHaveLength(7);
    for (const [label, overrides] of cases) {
      expect.soft(() => project(overrides), label).toThrow();
    }

    expect(() => project({ platform: "linux", architecture: "x64" }), "packaged Linux projection rejected")
      .toThrow("Desktop telemetry sealed release metadata is invalid.");

    expect(() => projectDesktopTelemetryRelease({
      packageMetadata: developmentTelemetryPackageMetadata("0.0"),
      appVersion: "0.0",
      platform: "linux",
      architecture: "x64",
      currentUpdateChannel: "development",
    }), "Electron's unsigned Linux app version rejected").toThrow("Desktop telemetry release version does not match package metadata.");
  });
});
