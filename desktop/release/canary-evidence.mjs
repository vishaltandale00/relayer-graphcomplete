import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DESKTOP_RELEASE, desktopReleaseTarget } from "./contract.mjs";
import { compareNumericVersions, isNumericVersion } from "./numeric-version.mjs";

async function sha256File(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

function expectedPrimaryNames(target, version) {
  const prefix = `Relayer-${version}-${target.format}-${target.architecture}`;
  return target.platform === "darwin" ? [`${prefix}.dmg`, `${prefix}.zip`] : [`${prefix}.exe`];
}

function readJsonLines(text) {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Canary trace line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
}

function releaseSigningMatches(releaseReceipt, target) {
  return target.platform === "darwin"
    ? Boolean(releaseReceipt?.signing?.mode) &&
      releaseReceipt.signing.appleTeamId === DESKTOP_RELEASE.appleTeamId &&
      releaseReceipt.signing.notarizationMode !== "disabled"
    : releaseReceipt?.signing?.mode === "azure-artifact-signing" &&
      releaseReceipt.signing.endpoint === DESKTOP_RELEASE.artifactSigningEndpoint &&
      releaseReceipt.signing.accountName === DESKTOP_RELEASE.artifactSigningAccountName &&
      Boolean(releaseReceipt.signing.certificateProfileName) &&
      Boolean(releaseReceipt.signing.publisherName);
}

function validateCandidate({ releaseReceipt, previewReceipt, target }) {
  const version = String(releaseReceipt?.version || "");
  const primaryNames = expectedPrimaryNames(target, version);
  if (
    releaseReceipt?.schemaVersion !== 2 ||
    releaseReceipt.product !== DESKTOP_RELEASE.productName ||
    releaseReceipt.appId !== DESKTOP_RELEASE.productionAppId ||
    releaseReceipt.target !== target.key ||
    releaseReceipt.platform !== target.distributionPlatform ||
    releaseReceipt.architecture !== target.architecture ||
    releaseReceipt.channel !== "preview" ||
    releaseReceipt.manifest !== target.channels.preview.manifestName ||
    releaseReceipt.updateBaseUrl !== target.updateBaseUrl ||
    releaseReceipt.minimumMacOSVersion !== target.minimumMacOSVersion ||
    !releaseSigningMatches(releaseReceipt, target) ||
    !isNumericVersion(version) ||
    !/^[a-f0-9]{40}$/.test(releaseReceipt.sourceCommit || "") ||
    !Array.isArray(releaseReceipt.artifacts)
  ) {
    throw new Error("Canary target release receipt is invalid.");
  }
  if (
    previewReceipt?.schemaVersion !== 2 ||
    previewReceipt.channel !== "preview" ||
    previewReceipt.target !== target.key ||
    previewReceipt.version !== version ||
    previewReceipt.sourceCommit !== releaseReceipt.sourceCommit ||
    !/^\d+$/.test(String(previewReceipt.workflowRunId || "")) ||
    !Array.isArray(previewReceipt.artifacts)
  ) {
    throw new Error("Canary Preview publication receipt is invalid.");
  }
  const releaseByName = new Map(releaseReceipt.artifacts.map((item) => [item.name, item]));
  const publishedByName = new Map(previewReceipt.artifacts.map((item) => [item.name, item]));
  for (const name of primaryNames) {
    const release = releaseByName.get(name);
    const published = publishedByName.get(name);
    if (
      !release || !published ||
      release.size !== published.size ||
      release.sha256 !== published.sha256 ||
      release.sha512 !== published.sha512
    ) {
      throw new Error(`Canary receipts do not identify the same ${name} bytes.`);
    }
  }
  return { version, primaryNames, publishedByName };
}

function validateSeedReceipt(seedReceipt, target, observedVersion) {
  if (
    seedReceipt?.schemaVersion !== 2 ||
    seedReceipt.product !== DESKTOP_RELEASE.productName ||
    seedReceipt.appId !== DESKTOP_RELEASE.productionAppId ||
    seedReceipt.version !== observedVersion ||
    seedReceipt.target !== target.key ||
    seedReceipt.platform !== target.distributionPlatform ||
    seedReceipt.architecture !== target.architecture ||
    seedReceipt.channel !== "preview" ||
    seedReceipt.manifest !== target.channels.preview.manifestName ||
    seedReceipt.updateBaseUrl !== target.updateBaseUrl ||
    seedReceipt.minimumMacOSVersion !== target.minimumMacOSVersion ||
    !releaseSigningMatches(seedReceipt, target) ||
    !Array.isArray(seedReceipt.artifacts) ||
    !/^[a-f0-9]{40}$/.test(seedReceipt.sourceCommit || "")
  ) {
    throw new Error("Canary seed release receipt does not match the observed Preview seed.");
  }
}

function buildProductFlow(records, version) {
  let priorTimestamp = -Infinity;
  for (const [index, record] of records.entries()) {
    const timestamp = Date.parse(record.capturedAt);
    if (!Number.isFinite(timestamp) || timestamp < priorTimestamp) {
      throw new Error(`Canary trace timestamp ${index + 1} is invalid or out of order.`);
    }
    priorTimestamp = timestamp;
  }
  const states = records.map((record) => record.state);
  const seedIdleIndex = states.findIndex((state) => (
    state?.phase === "idle" && state.channel === "preview" &&
    isNumericVersion(state.version) && state.version !== version && state.error == null
  ));
  const seed = seedIdleIndex >= 0 ? states[seedIdleIndex].version : null;
  if (!seed || compareNumericVersions(version, seed) <= 0) {
    throw new Error("Canary trace does not begin on an older numeric seed version.");
  }
  const seedProcessId = records[seedIdleIndex].processId;
  if (!Number.isInteger(seedProcessId) || seedProcessId <= 0) {
    throw new Error("Canary trace seed process identity is invalid.");
  }
  const availableIndex = states.findIndex((state, index) => index > seedIdleIndex && (
    state?.phase === "available" && state.version === seed && state.availableVersion === version && state.channel === "preview"
  ));
  const readyIndex = states.findIndex((state, index) => index > availableIndex && (
    state?.phase === "ready" && state.version === seed && state.availableVersion === version && state.channel === "preview"
  ));
  const installedIndex = states.findIndex((state, index) => index > readyIndex && (
    state?.phase === "idle" && state.version === version && state.channel === "preview" && state.error == null
  ));
  const downloadingRecords = records.filter((record, index) => index > availableIndex && index < readyIndex && (
    record.state?.phase === "downloading" && record.state.version === seed &&
    record.state.availableVersion === version && record.state.channel === "preview"
  ));
  if (availableIndex < 0 || readyIndex < 0 || installedIndex < 0 || downloadingRecords.length === 0) {
    throw new Error("Canary trace must prove ordered available, downloading, ready, and post-update idle states.");
  }
  const seedStageIndexes = [availableIndex, ...downloadingRecords.map((record) => records.indexOf(record)), readyIndex];
  if (seedStageIndexes.some((index) => records[index].processId !== seedProcessId)) {
    throw new Error("Canary update states must come from the same seed process.");
  }
  if (states.slice(seedIdleIndex, installedIndex + 1).some((state) => state?.phase === "failed" || state?.error)) {
    throw new Error("Canary trace contains a failure before target relaunch.");
  }
  const targetProcessId = records[installedIndex].processId;
  if (!Number.isInteger(targetProcessId) || targetProcessId <= 0 || seedProcessId === targetProcessId) {
    throw new Error("Canary trace must prove the target version relaunched in a new process.");
  }
  const displayedPercentages = downloadingRecords
    .map((record) => Number(record.state.percent))
    .filter(Number.isFinite);
  if (
    displayedPercentages.length !== downloadingRecords.length ||
    displayedPercentages.some((value) => value < 0 || value > 99) ||
    displayedPercentages.some((value, index) => index > 0 && value < displayedPercentages[index - 1])
  ) {
    throw new Error("Canary download progress must be complete, bounded, and monotonic.");
  }
  return {
    seed,
    seedProcessId,
    targetProcessId,
    productFlow: [
      { phase: "idle", version: seed, channel: "preview", error: null },
      { phase: "available", version: seed, availableVersion: version, channel: "preview", error: null },
      { phase: "downloading", version: seed, availableVersion: version, channel: "preview", displayedPercentages, error: null },
      { phase: "ready", version: seed, availableVersion: version, channel: "preview", error: null },
      { phase: "installed-and-relaunched", version, channel: "preview", error: null },
    ],
  };
}

export function deriveDesktopCanaryTrace({ text, target, version } = {}) {
  if (!target?.key || !isNumericVersion(version)) {
    throw new Error("Canary trace derivation requires a release target and numeric version.");
  }
  const records = readJsonLines(String(text || ""));
  if (records.length === 0 || records.some((record) => (
    record.schemaVersion !== 1 || record.target !== target.key ||
    record.platform !== target.platform || record.architecture !== target.architecture
  ))) {
    throw new Error("Canary trace contains records for the wrong target or schema.");
  }
  return { records, ...buildProductFlow(records, version) };
}

export async function createDesktopCanaryEvidence({
  targetReleaseReceiptPath,
  previewPublicationReceiptPath,
  seedReleaseReceiptPath = null,
  stateLogPath,
  screenshotPaths,
  outputPath,
  environment,
  running,
  codeSignatureVerified,
  platformAcceptanceVerified = null,
} = {}) {
  if (!targetReleaseReceiptPath || !previewPublicationReceiptPath || !stateLogPath || !outputPath) {
    throw new Error("Canary evidence requires target, publication, trace, and output paths.");
  }
  if (!environment?.host || !environment?.os || !environment?.architecture) {
    throw new Error("Canary evidence requires host, OS, and architecture details.");
  }
  if (running !== true || codeSignatureVerified !== true || platformAcceptanceVerified !== true) {
    throw new Error("Canary evidence requires a running, signature-verified, platform-accepted post-update application.");
  }
  const [releaseReceipt, previewReceipt, stateLogText, seedReceipt] = await Promise.all([
    readFile(resolve(targetReleaseReceiptPath), "utf8").then(JSON.parse),
    readFile(resolve(previewPublicationReceiptPath), "utf8").then(JSON.parse),
    readFile(resolve(stateLogPath), "utf8"),
    seedReleaseReceiptPath ? readFile(resolve(seedReleaseReceiptPath), "utf8").then(JSON.parse) : null,
  ]);
  const target = desktopReleaseTarget(releaseReceipt.target);
  if (environment.architecture !== target.architecture) {
    throw new Error(`Canary host architecture must be ${target.architecture}.`);
  }
  const candidate = validateCandidate({ releaseReceipt, previewReceipt, target });
  const flow = deriveDesktopCanaryTrace({ text: stateLogText, target, version: candidate.version });
  if (!seedReceipt) throw new Error("Canary evidence requires the signed seed release receipt.");
  validateSeedReceipt(seedReceipt, target, flow.seed);

  const requiredScreenshots = ["firstInstall", "available", "ready", "installed"];
  if (requiredScreenshots.some((name) => !screenshotPaths?.[name])) {
    throw new Error("Canary evidence requires first-install, available, ready, and installed screenshots.");
  }
  const outputDirectory = dirname(resolve(outputPath));
  await mkdir(outputDirectory, { recursive: true });
  const traceSource = resolve(stateLogPath);
  const traceFile = basename(traceSource);
  const traceDestination = join(outputDirectory, traceFile);
  if (traceSource !== traceDestination) await copyFile(traceSource, traceDestination);
  const screenshots = {};
  for (const name of requiredScreenshots) {
    const source = resolve(screenshotPaths[name]);
    const file = basename(source);
    const destination = join(outputDirectory, file);
    if (source !== destination) await copyFile(source, destination);
    screenshots[name] = { file, sha256: await sha256File(destination) };
  }
  const updaterStateScreenshotHashes = new Set([
    screenshots.available.sha256,
    screenshots.ready.sha256,
    screenshots.installed.sha256,
  ]);
  if (updaterStateScreenshotHashes.size !== 3) {
    throw new Error("Canary available, ready, and installed screenshots must be visually distinct.");
  }

  const artifactSha256 = Object.fromEntries(candidate.primaryNames.map((name) => [
    name,
    candidate.publishedByName.get(name).sha256,
  ]));
  const capture = {
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    environment: {
      target: target.key,
      host: environment.host,
      architecture: environment.architecture,
      os: environment.os,
    },
    seed: {
      version: flow.seed,
      sourceCommit: seedReceipt?.sourceCommit || null,
      processId: flow.seedProcessId,
    },
    target: {
      version: candidate.version,
      sourceCommit: releaseReceipt.sourceCommit,
      workflowRunId: previewReceipt.workflowRunId,
      artifactSha256,
    },
    productFlow: flow.productFlow,
    trace: {
      file: traceFile,
      sha256: await sha256File(traceDestination),
      records: flow.records.length,
    },
    postUpdate: {
      installedVersion: candidate.version,
      running: true,
      codeSignatureVerified: true,
      platformAcceptanceVerified,
      processId: flow.targetProcessId,
      channel: "preview",
      updateStatus: "idle",
    },
    screenshots,
  };
  await writeFile(resolve(outputPath), `${JSON.stringify(capture, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return capture;
}

function argument(name, { optional = false } = {}) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? String(process.argv[index + 1] || "").trim() : "";
  if (!value && !optional) throw new Error(`Missing required --${name} argument.`);
  return value || null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--print-target-process-id")) {
    const flow = deriveDesktopCanaryTrace({
      text: await readFile(argument("state-log"), "utf8"),
      target: desktopReleaseTarget(argument("target")),
      version: argument("target-version"),
    });
    process.stdout.write(String(flow.targetProcessId));
  } else {
    const capture = await createDesktopCanaryEvidence({
      targetReleaseReceiptPath: argument("target-release-receipt"),
      previewPublicationReceiptPath: argument("preview-publication-receipt"),
      seedReleaseReceiptPath: argument("seed-release-receipt", { optional: true }),
      stateLogPath: argument("state-log"),
      screenshotPaths: {
        firstInstall: argument("screenshot-first-install", { optional: true }),
        available: argument("screenshot-available"),
        ready: argument("screenshot-ready"),
        installed: argument("screenshot-installed"),
      },
      outputPath: argument("output"),
      environment: {
        host: argument("host"),
        os: argument("os"),
        architecture: argument("architecture"),
      },
      running: argument("running") === "true",
      codeSignatureVerified: argument("signature-verified") === "true",
      platformAcceptanceVerified: argument("platform-acceptance-verified", { optional: true }) === "true",
    });
    console.log(JSON.stringify({ ok: true, target: capture.environment.target, version: capture.target.version }, null, 2));
  }
}
