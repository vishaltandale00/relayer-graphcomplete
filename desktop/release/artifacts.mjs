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
  const prefix = `${DESKTOP_RELEASE.productName}-${contract.version}-mac-${contract.architecture}`;
  return Object.freeze({
    dmg: `${prefix}.dmg`,
    zip: `${prefix}.zip`,
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
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  if (files.length !== artifacts.length) {
    throw new Error(`${contract.manifestName} must contain exactly the update ZIP and DMG.`);
  }
  for (const artifact of artifacts) {
    const entry = files.find((candidate) => candidate?.url === artifact.name);
    if (!entry || entry.sha512 !== artifact.sha512 || Number(entry.size) !== artifact.size) {
      throw new Error(`${contract.manifestName} does not seal the exact ${artifact.name} bytes.`);
    }
  }
  const zip = artifacts.find((artifact) => artifact.name.endsWith(".zip"));
  if (manifest.path && manifest.path !== zip.name) {
    throw new Error(`${contract.manifestName} legacy path does not name the update ZIP.`);
  }
  if (manifest.sha512 && manifest.sha512 !== zip.sha512) {
    throw new Error(`${contract.manifestName} legacy hash does not match the update ZIP.`);
  }
}

export async function collectDesktopReleaseEvidence({ distRoot, contract } = {}) {
  if (!contract?.release) throw new Error("Release artifact evidence requires the signed release contract.");
  const names = desktopReleaseArtifactNames(contract);
  const [dmg, zip, manifestText] = await Promise.all([
    artifactEvidence(join(distRoot, names.dmg)),
    artifactEvidence(join(distRoot, names.zip)),
    readFile(join(distRoot, names.manifest), "utf8"),
  ]);
  const manifest = parseYaml(manifestText);
  validateManifest(manifest, contract, [zip, dmg]);
  return { names, dmg, zip, manifest };
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

export async function writeDesktopReleaseEvidence({ distRoot, contract } = {}) {
  const evidence = await collectDesktopReleaseEvidence({ distRoot, contract });
  const checksumText = [evidence.dmg, evidence.zip]
    .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
    .join("\n");
  const receipt = {
    schemaVersion: 1,
    product: DESKTOP_RELEASE.productName,
    appId: contract.appId,
    version: contract.version,
    architecture: contract.architecture,
    minimumMacOSVersion: contract.minimumMacOSVersion,
    channel: contract.channelName,
    manifest: contract.manifestName,
    updateBaseUrl: contract.updateBaseUrl,
    sourceCommit: contract.sourceCommit,
    appleTeamId: contract.appleTeamId,
    artifacts: [evidence.dmg, evidence.zip],
  };
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
  const expectedChecksums = [evidence.dmg, evidence.zip]
    .map((artifact) => `${artifact.sha256}  ${artifact.name}`)
    .join("\n");
  if (checksumText.trim() !== expectedChecksums) {
    throw new Error("Desktop release checksum manifest does not match the artifacts.");
  }
  const receipt = JSON.parse(receiptText);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.product !== DESKTOP_RELEASE.productName ||
    receipt.appId !== contract.appId ||
    receipt.version !== contract.version ||
    receipt.architecture !== contract.architecture ||
    receipt.minimumMacOSVersion !== contract.minimumMacOSVersion ||
    receipt.channel !== contract.channelName ||
    receipt.manifest !== contract.manifestName ||
    receipt.updateBaseUrl !== contract.updateBaseUrl ||
    receipt.sourceCommit !== contract.sourceCommit ||
    receipt.appleTeamId !== contract.appleTeamId ||
    JSON.stringify(receipt.artifacts) !== JSON.stringify([evidence.dmg, evidence.zip])
  ) {
    throw new Error("Desktop release receipt does not match the release contract and artifacts.");
  }
  return { ...evidence, receipt };
}
