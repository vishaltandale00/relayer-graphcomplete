import { join } from "node:path";

import { projectDesktopTelemetryRelease } from "../../shared/telemetry-release.mjs";
import { createDesktopAuthenticatedErrorReporting } from "./authenticated-error-reporting.mjs";

export const GRAPHCOMPLETE_SENTRY_DSN = "https://8c71bc3ff03f651ce765029091edac1e@o4510780407414784.ingest.us.sentry.io/4511989779988480";

export function createDesktopAccountTelemetry({ getReporting, refreshChildren } = {}) {
  if (typeof getReporting !== "function" || typeof refreshChildren !== "function") {
    throw new TypeError("Desktop account telemetry composition is invalid.");
  }
  const project = async (operation) => {
    try { await operation(getReporting()?.account); } catch {}
    try { await refreshChildren(); } catch {}
  };
  return Object.freeze({
    transitionIdentity: (identity) => project((account) => account?.transitionIdentity(identity)),
    retireIdentity: () => project((account) => account?.retireIdentity()),
  });
}

export function createDesktopErrorReporterIssuer({ getReporting, fetchImpl = fetch } = {}) {
  if (typeof getReporting !== "function") throw new TypeError("Desktop error-reporting authority lookup is required.");
  if (typeof fetchImpl !== "function") throw new TypeError("Desktop error-reporting capability transport is required.");
  return (component, processGeneration) => {
    let revoked = false;
    const activeReporters = new Set();
    return Object.freeze({
      async report(record) {
        if (revoked) return Object.freeze({ accepted: false, reason: "revoked" });
        let reporter;
        try {
          const reporting = getReporting();
          if (component === "electron-main") {
            reporter = reporting?.issueReporter({ component, processGeneration }) ?? null;
          } else {
            const capability = reporting?.issueCapability({ component, processGeneration }) ?? null;
            reporter = capability === null ? null : Object.freeze({
              async report(value) {
                const response = await fetchImpl(capability.endpoint, {
                  method: "POST",
                  headers: {
                    authorization: capability.authorization,
                    "content-type": "application/json",
                  },
                  body: JSON.stringify(value),
                });
                let result;
                try { result = await response.json(); } catch { result = null; }
                return result?.accepted === true
                  ? Object.freeze({ accepted: true, delivery: "submitted" })
                  : Object.freeze({ accepted: false, reason: "rejected" });
              },
              revoke: () => capability.revoke(),
            });
          }
        } catch {
          return Object.freeze({ accepted: false, reason: "unavailable" });
        }
        if (reporter === null) return Object.freeze({ accepted: false, reason: "unsigned" });
        activeReporters.add(reporter);
        if (revoked) {
          activeReporters.delete(reporter);
          try { reporter.revoke(); } catch {}
          return Object.freeze({ accepted: false, reason: "revoked" });
        }
        try {
          return await reporter.report(record);
        } catch {
          return Object.freeze({ accepted: false, reason: "unavailable" });
        } finally {
          activeReporters.delete(reporter);
          try { reporter.revoke(); } catch {}
        }
      },
      revoke() {
        revoked = true;
        for (const reporter of activeReporters) {
          try { reporter.revoke(); } catch {}
        }
        activeReporters.clear();
      },
    });
  };
}

export async function setDesktopAuthenticatedErrorChannel({
  reporting,
  account,
  releaseArtifact,
  channel,
} = {}) {
  if (releaseArtifact && typeof reporting?.updateEnvironment === "function") {
    try {
      await reporting.updateEnvironment(channel);
    } catch {}
  }
  return account.setChannel(channel);
}

async function createDefaultTransport(options) {
  const { createSentryErrorTransport } = await import("./sentry-error-transport.mjs");
  return createSentryErrorTransport(options);
}

export async function initializeDesktopAuthenticatedErrorReporting({
  userDataPath,
  packageMetadata,
  appVersion,
  platform,
  architecture,
  currentUpdateChannel,
  safeStorage,
  createTransport = createDefaultTransport,
  onUnavailable = () => {},
} = {}) {
  try {
    const releaseIdentity = projectDesktopTelemetryRelease({
      packageMetadata,
      appVersion,
      platform,
      architecture,
      currentUpdateChannel,
    });
    const transport = await createTransport({ dsn: GRAPHCOMPLETE_SENTRY_DSN });
    return await createDesktopAuthenticatedErrorReporting({
      queuePath: join(userDataPath, "authenticated-error-queue.json"),
      encrypt: async (value) => {
        if (safeStorage?.isEncryptionAvailable() !== true) {
          throw new Error("Operating-system telemetry encryption is unavailable.");
        }
        return safeStorage.encryptString(value).toString("base64");
      },
      decrypt: async (value) => {
        if (safeStorage?.isEncryptionAvailable() !== true) {
          throw new Error("Operating-system telemetry encryption is unavailable.");
        }
        return safeStorage.decryptString(Buffer.from(value, "base64"));
      },
      transport,
      releaseIdentity,
    });
  } catch {
    try {
      onUnavailable();
    } catch {}
    return null;
  }
}
