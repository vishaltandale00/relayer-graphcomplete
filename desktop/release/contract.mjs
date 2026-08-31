import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { compareNumericVersions, isNumericVersion } from "./numeric-version.mjs";
import { DESKTOP_UPDATE_BASE_URL } from "../shared/release-metadata.mjs";
import {
  desktopTargetByKey,
  desktopTargetFromEnvironment,
} from "../shared/target.mjs";

const execFileAsync = promisify(execFile);

export const DESKTOP_RELEASE = Object.freeze({
  productionAppId: "ai.relayer.desktop",
  developmentAppId: "ai.relayer.desktop.development",
  productName: "Relayer",
  developmentProductName: "Relayer Dev",
  minimumMacOSVersion: "13.3.0",
  minimumUpdateSystemVersion: "22.4.0",
  firstVersion: "0.2.0",
  updateBaseUrl: DESKTOP_UPDATE_BASE_URL,
  appleTeamId: "NZ253AL7U6",
  artifactSigningAccountName: "relayercodesigning",
  artifactSigningEndpoint: "https://eus.codesigning.azure.net/",
});

export const DESKTOP_RELEASE_TARGETS = Object.freeze({
  "macos-arm64": Object.freeze({
    ...desktopTargetByKey("macos-arm64"),
    updateBaseUrl: "https://updates.relayerlabs.ai/desktop/macos/arm64",
    publicPrefix: "desktop/macos/arm64",
    minimumMacOSVersion: DESKTOP_RELEASE.minimumMacOSVersion,
    minimumUpdateSystemVersion: DESKTOP_RELEASE.minimumUpdateSystemVersion,
    channels: Object.freeze({
      stable: Object.freeze({ providerChannel: "latest", manifestName: "latest-mac.yml" }),
      preview: Object.freeze({ providerChannel: "beta", manifestName: "beta-mac.yml" }),
    }),
  }),
  "macos-x64": Object.freeze({
    ...desktopTargetByKey("macos-x64"),
    updateBaseUrl: "https://updates.relayerlabs.ai/desktop/macos/x64",
    publicPrefix: "desktop/macos/x64",
    minimumMacOSVersion: DESKTOP_RELEASE.minimumMacOSVersion,
    minimumUpdateSystemVersion: DESKTOP_RELEASE.minimumUpdateSystemVersion,
    channels: Object.freeze({
      stable: Object.freeze({ providerChannel: "latest", manifestName: "latest-mac.yml" }),
      preview: Object.freeze({ providerChannel: "beta", manifestName: "beta-mac.yml" }),
    }),
  }),
  "windows-x64": Object.freeze({
    ...desktopTargetByKey("windows-x64"),
    updateBaseUrl: "https://updates.relayerlabs.ai/desktop/windows/x64",
    publicPrefix: "desktop/windows/x64",
    minimumMacOSVersion: null,
    minimumUpdateSystemVersion: null,
    channels: Object.freeze({
      stable: Object.freeze({ providerChannel: "latest", manifestName: "latest.yml" }),
      preview: Object.freeze({ providerChannel: "beta", manifestName: "beta.yml" }),
    }),
  }),
});

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

function value(environment, name) {
  return String(environment[name] || "").trim();
}

function hasAll(environment, names) {
  return names.every((name) => value(environment, name));
}

export function desktopReleaseTarget(key = "macos-arm64") {
  const target = DESKTOP_RELEASE_TARGETS[String(key || "").trim()];
  if (!target) throw new Error(`Unsupported Relayer Desktop release target: ${key || "(empty)"}.`);
  return target;
}

export function resolveDesktopNotarizationCredentials(environment = process.env) {
  if (hasAll(environment, ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"])) {
    return {
      mode: "app-store-connect-api-key",
      notarytoolArgs: [
        "--key", value(environment, "APPLE_API_KEY"),
        "--key-id", value(environment, "APPLE_API_KEY_ID"),
        "--issuer", value(environment, "APPLE_API_ISSUER"),
      ],
    };
  }
  if (hasAll(environment, ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"])) {
    return {
      mode: "apple-id",
      notarytoolArgs: [
        "--apple-id", value(environment, "APPLE_ID"),
        "--password", value(environment, "APPLE_APP_SPECIFIC_PASSWORD"),
        "--team-id", value(environment, "APPLE_TEAM_ID"),
      ],
    };
  }
  if (hasAll(environment, ["APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE"])) {
    return {
      mode: "keychain-profile",
      notarytoolArgs: [
        "--keychain-profile", value(environment, "APPLE_KEYCHAIN_PROFILE"),
        "--keychain", value(environment, "APPLE_KEYCHAIN"),
      ],
    };
  }
  throw new Error(
    "Desktop release requires App Store Connect API-key, Apple-ID, or notarytool keychain-profile credentials.",
  );
}

export function resolveDesktopReleaseContract({
  environment = process.env,
  version,
  sourceCommit,
} = {}) {
  const release = value(environment, "RELAYER_DESKTOP_RELEASE") === "1";
  const target = release
    ? desktopReleaseTarget(value(environment, "RELAYER_DESKTOP_TARGET") || "macos-arm64")
    : desktopReleaseTarget(desktopTargetFromEnvironment(environment).key);
  const channelName = value(environment, "RELAYER_DESKTOP_CHANNEL") || "stable";
  const channel = target.channels[channelName];
  if (!channel) {
    throw new Error("RELAYER_DESKTOP_CHANNEL must be stable or preview.");
  }
  if (!isNumericVersion(version)) {
    throw new Error("Desktop version must be numeric major.minor.patch.");
  }

  if (!release) {
    const normalizedDevelopmentCommit = String(sourceCommit || "").trim().toLowerCase();
    if (normalizedDevelopmentCommit && !GIT_SHA_PATTERN.test(normalizedDevelopmentCommit)) {
      throw new Error("Desktop development evidence requires a full 40-character source commit SHA.");
    }
    return Object.freeze({
      release: false,
      artifactMode: "development",
      appId: DESKTOP_RELEASE.developmentAppId,
      productName: DESKTOP_RELEASE.developmentProductName,
      version,
      targetKey: target.key,
      platform: target.platform,
      distributionPlatform: target.distributionPlatform,
      artifactPlatform: target.format,
      architecture: target.architecture,
      rustTarget: target.rustTarget,
      publicPrefix: target.publicPrefix,
      minimumMacOSVersion: target.minimumMacOSVersion,
      minimumUpdateSystemVersion: target.minimumUpdateSystemVersion,
      channelName: "development",
      providerChannel: null,
      manifestName: null,
      updateBaseUrl: null,
      sourceCommit: normalizedDevelopmentCommit || null,
      signingIdentity: null,
      signingMode: "unsigned",
      notarizationMode: "disabled",
      appleTeamId: null,
      artifactSigningEndpoint: null,
      artifactSigningAccountName: null,
      artifactSigningCertificateProfileName: null,
      publisherName: null,
    });
  }

  if (compareNumericVersions(version, DESKTOP_RELEASE.firstVersion) < 0) {
    throw new Error(`Desktop release version must be ${DESKTOP_RELEASE.firstVersion} or newer.`);
  }
  const normalizedCommit = String(sourceCommit || "").trim().toLowerCase();
  if (!GIT_SHA_PATTERN.test(normalizedCommit)) {
    throw new Error("Desktop release requires a full 40-character source commit SHA.");
  }

  const updateBaseUrl = value(environment, "RELAYER_DESKTOP_UPDATE_BASE_URL");
  if (updateBaseUrl !== target.updateBaseUrl) {
    throw new Error(`RELAYER_DESKTOP_UPDATE_BASE_URL must be exactly ${target.updateBaseUrl}.`);
  }

  let signingIdentity = null;
  let signingMode;
  let notarizationMode = "disabled";
  let appleTeamId = null;
  let artifactSigningEndpoint = null;
  let artifactSigningAccountName = null;
  let artifactSigningCertificateProfileName = null;
  let publisherName = null;
  if (target.platform === "darwin") {
    signingIdentity = value(environment, "RELAYER_DESKTOP_SIGN_IDENTITY") || value(environment, "CSC_NAME");
    if (!signingIdentity.startsWith("Developer ID Application:")) {
      throw new Error("macOS desktop release requires a Developer ID Application signing identity.");
    }
    appleTeamId = /\(([A-Z0-9]{6,})\)\s*$/.exec(signingIdentity)?.[1] || "";
    if (appleTeamId !== DESKTOP_RELEASE.appleTeamId) {
      throw new Error(`Desktop release signing identity must belong to Apple team ${DESKTOP_RELEASE.appleTeamId}.`);
    }
    const hasCertificateLink = Boolean(value(environment, "CSC_LINK"));
    const hasCertificatePassword = Boolean(value(environment, "CSC_KEY_PASSWORD"));
    if (hasCertificateLink !== hasCertificatePassword) {
      throw new Error("CSC_LINK and CSC_KEY_PASSWORD must be provided together.");
    }
    const notarization = resolveDesktopNotarizationCredentials(environment);
    signingMode = hasCertificateLink ? "certificate-file" : "keychain-identity";
    notarizationMode = notarization.mode;
  } else {
    artifactSigningEndpoint = value(environment, "RELAYER_WINDOWS_SIGNING_ENDPOINT");
    artifactSigningAccountName = value(environment, "RELAYER_WINDOWS_SIGNING_ACCOUNT");
    artifactSigningCertificateProfileName = value(environment, "RELAYER_WINDOWS_CERTIFICATE_PROFILE");
    publisherName = value(environment, "RELAYER_WINDOWS_PUBLISHER_NAME");
    if (artifactSigningEndpoint !== DESKTOP_RELEASE.artifactSigningEndpoint) {
      throw new Error(`RELAYER_WINDOWS_SIGNING_ENDPOINT must be exactly ${DESKTOP_RELEASE.artifactSigningEndpoint}.`);
    }
    if (artifactSigningAccountName !== DESKTOP_RELEASE.artifactSigningAccountName) {
      throw new Error(`RELAYER_WINDOWS_SIGNING_ACCOUNT must be exactly ${DESKTOP_RELEASE.artifactSigningAccountName}.`);
    }
    if (!artifactSigningCertificateProfileName) {
      throw new Error("Windows desktop release requires RELAYER_WINDOWS_CERTIFICATE_PROFILE.");
    }
    if (!publisherName.startsWith("CN=") || !publisherName.includes(", O=")) {
      throw new Error(
        "Windows desktop release requires RELAYER_WINDOWS_PUBLISHER_NAME to be the exact certificate distinguished name.",
      );
    }
    signingMode = "azure-artifact-signing";
  }

  return Object.freeze({
    release: true,
    artifactMode: "release",
    appId: DESKTOP_RELEASE.productionAppId,
    productName: DESKTOP_RELEASE.productName,
    version,
    targetKey: target.key,
    platform: target.platform,
    distributionPlatform: target.distributionPlatform,
    artifactPlatform: target.format,
    architecture: target.architecture,
    rustTarget: target.rustTarget,
    publicPrefix: target.publicPrefix,
    minimumMacOSVersion: target.minimumMacOSVersion,
    minimumUpdateSystemVersion: target.minimumUpdateSystemVersion,
    channelName,
    providerChannel: channel.providerChannel,
    manifestName: channel.manifestName,
    updateBaseUrl,
    sourceCommit: normalizedCommit,
    signingIdentity,
    signingMode,
    notarizationMode,
    appleTeamId,
    artifactSigningEndpoint,
    artifactSigningAccountName,
    artifactSigningCertificateProfileName,
    publisherName,
  });
}

export async function loadDesktopReleaseContract({
  environment = process.env,
  desktopRoot = resolve(import.meta.dirname, ".."),
  execute = execFileAsync,
} = {}) {
  const packageMetadata = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8"));
  const release = value(environment, "RELAYER_DESKTOP_RELEASE") === "1";
  const declaredCommit = value(environment, "RELAYER_DESKTOP_SOURCE_COMMIT");
  let sourceCommit = null;
  if (release || declaredCommit) {
    const repositoryRoot = resolve(desktopRoot, "..");
    const [{ stdout: commitOutput }, { stdout: statusOutput }] = await Promise.all([
      execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }),
      execute("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repositoryRoot, encoding: "utf8" }),
    ]);
    if (String(statusOutput).trim()) {
      throw new Error("Source-bound desktop builds must be built from a clean Git worktree.");
    }
    const checkedOutCommit = String(commitOutput).trim();
    if (declaredCommit && declaredCommit !== checkedOutCommit) {
      throw new Error("RELAYER_DESKTOP_SOURCE_COMMIT must match the checked-out Git commit.");
    }
    sourceCommit = declaredCommit || checkedOutCommit;
  }
  return resolveDesktopReleaseContract({ environment, version: packageMetadata.version, sourceCommit });
}

export function electronBuilderSigningIdentity(signingIdentity) {
  return String(signingIdentity || "").replace(/^Developer ID Application:\s*/, "") || undefined;
}
