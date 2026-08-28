import { describe, expect, it } from "vitest";

import { projectDesktopTelemetryRelease } from "../desktop/shared/telemetry-release.mjs";
import { DESKTOP_UPDATE_BASE_URLS } from "../desktop/shared/release-metadata.mjs";

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
  it("keeps a packaged candidate's release immutable when Preview bytes move to Stable", () => {
    const preview = project();
    const stable = project({ currentUpdateChannel: "stable" });

    expect(preview).toEqual({
      release: `ai.relayer.desktop@0.2.16+${sourceCommit}`,
      environment: "preview",
      os: "macos",
      architecture: "arm64",
    });
    expect(stable).toEqual({ ...preview, environment: "stable" });
    expect(stable.release).toBe(preview.release);
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(stable)).toBe(true);
  });

  it("projects an explicit development identity without accepting release metadata", () => {
    expect(projectDesktopTelemetryRelease({
      packageMetadata: {
        version: "0.2.16",
        relayerArtifactMode: "development",
        relayerProductName: "Relayer Dev",
      },
      appVersion: "0.2.16",
      platform: "darwin",
      architecture: "arm64",
      currentUpdateChannel: "development",
    })).toEqual({
      release: "ai.relayer.desktop.development@0.2.16",
      environment: "development",
      os: "macos",
      architecture: "arm64",
    });
  });

  it.each([
    ["caller release override", { release: "attacker@9.9.9" }],
    ["caller environment override", { environment: "stable" }],
    ["version mismatch", { packageMetadata: packagedMetadata({ version: "0.2.15" }) }],
    ["invalid source commit", { packageMetadata: packagedMetadata({ relayerReleaseSourceCommit: "main" }) }],
    ["wrong runtime architecture", { architecture: "x64" }],
    ["Stable-authored package ambiguity", { packageMetadata: packagedMetadata({ relayerUpdateChannel: "stable" }) }],
    ["invalid current channel", { currentUpdateChannel: "beta" }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => project(overrides)).toThrow();
  });
});
