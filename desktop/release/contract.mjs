import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { compareNumericVersions, isNumericVersion } from "./numeric-version.mjs";
import { DESKTOP_UPDATE_BASE_URL } from "../shared/release-metadata.mjs";

const execFileAsync = promisify(execFile);

export const DESKTOP_RELEASE = Object.freeze({
  productionAppId: "ai.relayer.desktop",
  developmentAppId: "ai.relayer.desktop.development",
  productName: "Relayer",
  developmentProductName: "Relayer Dev",
  architecture: "arm64",
  minimumMacOSVersion: "13.0.0",
  firstVersion: "0.2.0",
  updateBaseUrl: DESKTOP_UPDATE_BASE_URL,
  appleTeamId: "NZ253AL7U6",
});

const CHANNELS = Object.freeze({
  stable: Object.freeze({ providerChannel: "latest", manifestName: "latest-mac.yml" }),
  preview: Object.freeze({ providerChannel: "beta", manifestName: "beta-mac.yml" }),
});

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;

function value(environment, name) {
  return String(environment[name] || "").trim();
}

function hasAll(environment, names) {
  return names.every((name) => value(environment, name));
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
  const channelName = value(environment, "RELAYER_DESKTOP_CHANNEL") || "stable";
  const channel = CHANNELS[channelName];
  if (!channel) {
    throw new Error("RELAYER_DESKTOP_CHANNEL must be stable or preview.");
  }
  if (!isNumericVersion(version)) {
    throw new Error("Desktop version must be numeric major.minor.patch.");
  }

  if (!release) {
    return Object.freeze({
      release: false,
      artifactMode: "development",
      appId: DESKTOP_RELEASE.developmentAppId,
      productName: DESKTOP_RELEASE.developmentProductName,
      version,
      architecture: DESKTOP_RELEASE.architecture,
      minimumMacOSVersion: DESKTOP_RELEASE.minimumMacOSVersion,
      channelName: "development",
      providerChannel: null,
      manifestName: null,
      updateBaseUrl: null,
      sourceCommit: null,
      signingIdentity: null,
      signingMode: "unsigned",
      notarizationMode: "disabled",
      appleTeamId: null,
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
  if (updateBaseUrl !== DESKTOP_RELEASE.updateBaseUrl) {
    throw new Error(`RELAYER_DESKTOP_UPDATE_BASE_URL must be exactly ${DESKTOP_RELEASE.updateBaseUrl}.`);
  }

  const signingIdentity = value(environment, "RELAYER_DESKTOP_SIGN_IDENTITY") || value(environment, "CSC_NAME");
  if (!signingIdentity.startsWith("Developer ID Application:")) {
    throw new Error("Desktop release requires a Developer ID Application signing identity.");
  }
  const appleTeamId = /\(([A-Z0-9]{6,})\)\s*$/.exec(signingIdentity)?.[1] || "";
  if (appleTeamId !== DESKTOP_RELEASE.appleTeamId) {
    throw new Error(`Desktop release signing identity must belong to Apple team ${DESKTOP_RELEASE.appleTeamId}.`);
  }
  const hasCertificateLink = Boolean(value(environment, "CSC_LINK"));
  const hasCertificatePassword = Boolean(value(environment, "CSC_KEY_PASSWORD"));
  if (hasCertificateLink !== hasCertificatePassword) {
    throw new Error("CSC_LINK and CSC_KEY_PASSWORD must be provided together.");
  }
  const notarization = resolveDesktopNotarizationCredentials(environment);

  return Object.freeze({
    release: true,
    artifactMode: "release",
    appId: DESKTOP_RELEASE.productionAppId,
    productName: DESKTOP_RELEASE.productName,
    version,
    architecture: DESKTOP_RELEASE.architecture,
    minimumMacOSVersion: DESKTOP_RELEASE.minimumMacOSVersion,
    channelName,
    providerChannel: channel.providerChannel,
    manifestName: channel.manifestName,
    updateBaseUrl,
    sourceCommit: normalizedCommit,
    signingIdentity,
    signingMode: hasCertificateLink ? "certificate-file" : "keychain-identity",
    notarizationMode: notarization.mode,
    appleTeamId,
  });
}

export async function loadDesktopReleaseContract({
  environment = process.env,
  desktopRoot = resolve(import.meta.dirname, ".."),
  execute = execFileAsync,
} = {}) {
  const packageMetadata = JSON.parse(await readFile(resolve(desktopRoot, "package.json"), "utf8"));
  const release = value(environment, "RELAYER_DESKTOP_RELEASE") === "1";
  let sourceCommit = null;
  if (release) {
    const repositoryRoot = resolve(desktopRoot, "..");
    const [{ stdout: commitOutput }, { stdout: statusOutput }] = await Promise.all([
      execute("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }),
      execute("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repositoryRoot, encoding: "utf8" }),
    ]);
    if (String(statusOutput).trim()) {
      throw new Error("Desktop releases must be built from a clean Git worktree.");
    }
    const checkedOutCommit = String(commitOutput).trim();
    const declaredCommit = value(environment, "RELAYER_DESKTOP_SOURCE_COMMIT");
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
