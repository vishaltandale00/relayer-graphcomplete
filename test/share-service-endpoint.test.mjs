import { describe, expect, it } from "vitest";

import {
  PRODUCTION_SHARE_SERVICE_ENDPOINT,
  resolveShareServiceEndpoint,
} from "../desktop/main/services/share-service-endpoint.mjs";

import { resolveDesktopReleaseContract } from "../desktop/release/contract.mjs";
import { createDesktopBuilderConfig } from "../desktop/packaging/electron-builder.mjs";

const developmentMetadata = createDesktopBuilderConfig(resolveDesktopReleaseContract({
  environment: { RELAYER_DESKTOP_TARGET: "windows-x64" },
  version: "0.2.0",
  sourceCommit: "3c641e1c2fbb58e4973475819a5c5c93dddd79c0",
}), { environment: { CI: "true" }, argv: ["--dir"] }).extraMetadata;

describe("share-service endpoint authority", () => {
  it("starts the real unsigned package with the fixed production origin and no override authority", () => {
    expect(resolveShareServiceEndpoint({
      isPackaged: true,
      packagedRelease: null,
      metadata: { ...developmentMetadata, relayerShareServiceEndpoint: "https://attacker.example" },
      platform: "win32", architecture: "x64",
      environment: { RELAYER_SHARE_SERVICE_ENDPOINT: "http://127.0.0.1:8787" },
    })).toBe(PRODUCTION_SHARE_SERVICE_ENDPOINT);
  });

  it.each([
    ["relayerArtifactMode", "release"],
    ["relayerProductName", "Relayer"],
    ["version", "invalid"],
    ["version", "00.2.0"],
    ["version", `${"1".repeat(33)}.2.0`],
    ["relayerUpdateChannel", "preview"],
    ["relayerUpdateBaseUrl", "https://updates.relayerlabs.ai/desktop/windows/x64"],
    ["relayerReleaseTarget", "macos-arm64"],
    ["relayerReleasePlatform", "macos"],
    ["relayerReleaseArchitecture", "arm64"],
  ])("rejects an invalid packaged development identity at %s", (field, value) => {
    expect(() => resolveShareServiceEndpoint({
      isPackaged: true, packagedRelease: null,
      metadata: { ...developmentMetadata, [field]: value },
      platform: "win32", architecture: "x64",
      environment: { RELAYER_SHARE_SERVICE_ENDPOINT: "https://attacker.example" },
    })).toThrow(/metadata is invalid/);
  });
  it("rejects a packaged app with missing sealed metadata before environment overrides", () => {
    expect(() => resolveShareServiceEndpoint({
      isPackaged: true,
      packagedRelease: null,
      environment: { RELAYER_SHARE_SERVICE_ENDPOINT: "https://attacker.example" },
    })).toThrow(/metadata is invalid/);
  });
  it("pins stable releases to the production origin regardless of process environment", () => {
    expect(resolveShareServiceEndpoint({
      packagedRelease: { channel: "stable" },
      metadata: {},
      environment: { RELAYER_SHARE_SERVICE_ENDPOINT: "https://attacker.example" },
    })).toBe(PRODUCTION_SHARE_SERVICE_ENDPOINT);
  });

  it("keeps the production origin when identical Preview bytes are promoted to Stable", () => {
    expect(resolveShareServiceEndpoint({
      packagedRelease: { channel: "preview" },
      metadata: { relayerShareServiceEndpoint: "https://share-preview.relayerlabs.ai" },
      environment: { RELAYER_SHARE_SERVICE_ENDPOINT: "https://attacker.example" },
    })).toBe(PRODUCTION_SHARE_SERVICE_ENDPOINT);

    expect(resolveShareServiceEndpoint({
      packagedRelease: { channel: "preview" },
      metadata: {},
    })).toBe(PRODUCTION_SHARE_SERVICE_ENDPOINT);
  });

  it("allows an explicit loopback or HTTPS override only in development", () => {
    expect(resolveShareServiceEndpoint({
      isPackaged: false,
      packagedRelease: null,
      metadata: {},
      environment: { RELAYER_SHARE_SERVICE_ENDPOINT: "http://127.0.0.1:8787" },
    })).toBe("http://127.0.0.1:8787");
    expect(() => resolveShareServiceEndpoint({
      isPackaged: false,
      packagedRelease: null,
      metadata: {},
      environment: { RELAYER_SHARE_SERVICE_ENDPOINT: "http://preview.example" },
    })).toThrow(/HTTPS or loopback/i);
  });
});
