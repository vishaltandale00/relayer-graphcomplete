import { packagedDesktopReleaseMetadata } from "./release-metadata.mjs";
import { desktopTarget, developmentDesktopHost } from "./target.mjs";

const PRODUCTION_APP_ID = "ai.relayer.desktop";
const DEVELOPMENT_APP_ID = "ai.relayer.desktop.development";
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const INPUT_FIELDS = Object.freeze([
  "appVersion",
  "architecture",
  "currentUpdateChannel",
  "packageMetadata",
  "platform",
]);

function requireExactInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Desktop telemetry release projection requires an input object.");
  }
  const fields = Object.keys(input).sort();
  if (fields.length !== INPUT_FIELDS.length || fields.some((field, index) => field !== INPUT_FIELDS[index])) {
    throw new TypeError("Desktop telemetry release projection contains an unsupported caller field.");
  }
}

function requireVersion(packageMetadata, appVersion) {
  if (!VERSION_PATTERN.test(appVersion) || packageMetadata?.version !== appVersion) {
    throw new Error("Desktop telemetry release version does not match package metadata.");
  }
}

export function developmentTelemetryPackageMetadata(version) {
  return {
    version,
    relayerArtifactMode: "development",
    relayerProductName: "Relayer Dev",
  };
}

function developmentProjection({ packageMetadata, appVersion, platform, architecture, currentUpdateChannel }) {
  if (
    packageMetadata.relayerProductName !== "Relayer Dev"
    || currentUpdateChannel !== "development"
  ) {
    throw new Error("Desktop telemetry development identity is invalid.");
  }
  const target = developmentDesktopHost({ platform, architecture });
  return Object.freeze({
    release: `${DEVELOPMENT_APP_ID}@${appVersion}`,
    environment: "development",
    os: target.distributionPlatform,
    architecture: target.architecture,
  });
}

function packagedProjection({ packageMetadata, appVersion, platform, architecture, currentUpdateChannel }) {
  if (currentUpdateChannel !== "preview" && currentUpdateChannel !== "stable") {
    throw new Error("Desktop telemetry release environment is invalid.");
  }
  const sealed = packagedDesktopReleaseMetadata(packageMetadata, { platform, architecture });
  const sourceCommit = String(packageMetadata.relayerReleaseSourceCommit || "");
  if (
    !sealed
    || sealed.channel !== "preview"
    || packageMetadata.relayerProductName !== "Relayer"
    || !SOURCE_COMMIT_PATTERN.test(sourceCommit)
  ) {
    throw new Error("Desktop telemetry sealed release metadata is invalid.");
  }
  const target = desktopTarget({ platform, architecture });
  if (target.key !== sealed.targetKey) {
    throw new Error("Desktop telemetry release target does not match the runtime target.");
  }
  return Object.freeze({
    release: `${PRODUCTION_APP_ID}@${appVersion}+${sourceCommit}`,
    environment: currentUpdateChannel,
    os: target.distributionPlatform,
    architecture: target.architecture,
  });
}

export function projectDesktopTelemetryRelease(input) {
  requireExactInput(input);
  const { packageMetadata, appVersion } = input;
  if (!packageMetadata || typeof packageMetadata !== "object" || Array.isArray(packageMetadata)) {
    throw new TypeError("Desktop telemetry package metadata is required.");
  }
  requireVersion(packageMetadata, appVersion);
  if (packageMetadata.relayerArtifactMode === "development") return developmentProjection(input);
  if (packageMetadata.relayerArtifactMode === "release") return packagedProjection(input);
  throw new Error("Desktop telemetry artifact mode is invalid.");
}
