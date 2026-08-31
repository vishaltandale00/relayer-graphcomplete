import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { parse as parseYaml } from "yaml";

import { DESKTOP_RELEASE } from "./contract.mjs";

async function hashFile(filePath, algorithm, encoding) {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest(encoding);
}

async function artifactEvidence(filePath) {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new Error(`${basename(filePath)} must be a non-empty regular file.`);
  }
  const [sha256, sha512] = await Promise.all([
    hashFile(filePath, "sha256", "hex"),
    hashFile(filePath, "sha512", "base64"),
  ]);
  return { name: basename(filePath), size: fileStat.size, sha256, sha512 };
}

export function desktopReleaseArtifactNames(contract) {
  const prefix = `${DESKTOP_RELEASE.productName}-${contract.version}-${contract.artifactPlatform}-${contract.architecture}`;
  const primary = contract.platform === "darwin"
    ? [`${prefix}.dmg`, `${prefix}.zip`]
    : [`${prefix}.exe`];
  return Object.freeze({
    prefix,
    primary: Object.freeze(primary),
    dmg: contract.platform === "darwin" ? primary[0] : null,
    zip: contract.platform === "darwin" ? primary[1] : null,
    installer: contract.platform === "win32" ? primary[0] : null,
    manifest: contract.manifestName,
    checksums: `${prefix}-SHA256SUMS.txt`,
    receipt: `${prefix}-RELEASE.json`,
  });
}

function validateManifest(manifest, contract, artifacts) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${contract.manifestName} must contain a YAML object.`);
  }
  if (String(manifest.version) !== contract.version) {
    throw new Error(`${contract.manifestName} version does not match ${contract.version}.`);
  }
  if (contract.platform === "darwin") {
    if (manifest.minimumSystemVersion !== contract.minimumUpdateSystemVersion) {
      throw new Error(`${contract.manifestName} minimum system version does not match the release contract.`);
    }
  } else if (manifest.minimumSystemVersion != null) {
    throw new Error(`${contract.manifestName} must not declare a macOS minimum system version.`);
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length !== artifacts.length) {
    throw new Error(`${contract.manifestName} must contain exactly ${artifacts.length} release artifact(s).`);
  }
  for (const artifact of artifacts) {
    const entry = files.find((candidate) => candidate?.url === artifact.name);
    if (!entry || entry.sha512 !== artifact.sha512 || Number(entry.size) !== artifact.size) {
      throw new Error(`${contract.manifestName} does not seal the exact ${artifact.name} bytes.`);
    }
  }
  const updateArtifact = contract.platform === "darwin"
    ? artifacts.find((artifact) => artifact.name.endsWith(".zip"))
    : artifacts.find((artifact) => artifact.name.endsWith(".exe"));
  if (manifest.path && manifest.path !== updateArtifact.name) {
    throw new Error(`${contract.manifestName} legacy path does not name the update artifact.`);
  }
  if (manifest.sha512 && manifest.sha512 !== updateArtifact.sha512) {
    throw new Error(`${contract.manifestName} legacy hash does not match the update artifact.`);
  }
}

export async function collectDesktopReleaseEvidence({ distRoot, contract } = {}) {
  if (!contract?.release) throw new Error("Release artifact evidence requires the signed release contract.");
  const names = desktopReleaseArtifactNames(contract);
  const [artifacts, manifestText] = await Promise.all([
    Promise.all(names.primary.map((name) => artifactEvidence(join(distRoot, name)))),
    readFile(join(distRoot, names.manifest), "utf8"),
  ]);
  const manifest = parseYaml(manifestText);
  validateManifest(manifest, contract, artifacts);
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  return {
    names,
    artifacts,
    dmg: names.dmg ? byName.get(names.dmg) : null,
    zip: names.zip ? byName.get(names.zip) : null,
    installer: names.installer ? byName.get(names.installer) : null,
    manifest,
  };
}

async function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function releaseReceipt(contract, evidence) {
  return {
    schemaVersion: 2,
    product: DESKTOP_RELEASE.productName,
    appId: contract.appId,
    version: contract.version,
    target: contract.targetKey,
    platform: contract.distributionPlatform,
    architecture: contract.architecture,
    minimumMacOSVersion: contract.minimumMacOSVersion,
    channel: contract.channelName,
    manifest: contract.manifestName,
    updateBaseUrl: contract.updateBaseUrl,
    sourceCommit: contract.sourceCommit,
    ...(contract.candidateWorkflowRunId ? {
      candidateWorkflowRunId: contract.candidateWorkflowRunId,
      candidateWorkflowRunAttempt: contract.candidateWorkflowRunAttempt,
    } : {}),
    signing: contract.platform === "darwin"
      ? { mode: contract.signingMode, appleTeamId: contract.appleTeamId, notarizationMode: contract.notarizationMode }
      : {
          mode: contract.signingMode,
          endpoint: contract.artifactSigningEndpoint,
          accountName: contract.artifactSigningAccountName,
          certificateProfileName: contract.artifactSigningCertificateProfileName,
          publisherName: contract.publisherName,
        },
    artifacts: evidence.artifacts,
  };
}

export async function writeDesktopReleaseEvidence({ distRoot, contract } = {}) {
  const evidence = await collectDesktopReleaseEvidence({ distRoot, contract });
  const checksumText = evidence.artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
    .join("\n");
  const receipt = releaseReceipt(contract, evidence);
  await Promise.all([
    atomicWrite(join(distRoot, evidence.names.checksums), `${checksumText}\n`),
    atomicWrite(join(distRoot, evidence.names.receipt), `${JSON.stringify(receipt, null, 2)}\n`),
  ]);
  return { ...evidence, receipt };
}

export async function verifyDesktopReleaseEvidence({ distRoot, contract } = {}) {
  const evidence = await collectDesktopReleaseEvidence({ distRoot, contract });
  const [checksumText, receiptText] = await Promise.all([
    readFile(join(distRoot, evidence.names.checksums), "utf8"),
    readFile(join(distRoot, evidence.names.receipt), "utf8"),
  ]);
  const expectedChecksums = evidence.artifacts
    .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
    .join("\n");
  if (checksumText.trim() !== expectedChecksums) {
    throw new Error("Desktop release checksum manifest does not match the artifacts.");
  }
  const receipt = JSON.parse(receiptText);
  if (JSON.stringify(receipt) !== JSON.stringify(releaseReceipt(contract, evidence))) {
    throw new Error("Desktop release receipt does not match the release contract and artifacts.");
  }
  return { ...evidence, receipt };
}
