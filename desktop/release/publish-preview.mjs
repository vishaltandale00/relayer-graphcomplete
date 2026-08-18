import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { DESKTOP_RELEASE } from "./contract.mjs";
import { compareNumericVersions, isNumericVersion } from "./numeric-version.mjs";

const execFileAsync = promisify(execFile);
const PUBLIC_PREFIX = "desktop/macos/arm64";
const IMMUTABLE_CACHE_CONTROL = "public,max-age=31536000,immutable";
const POINTER_CACHE_CONTROL = "no-store,no-cache,must-revalidate,max-age=0";

function contentType(name) {
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".yml")) return "text/yaml; charset=utf-8";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".txt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

async function fileEvidence(filePath) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length;
    sha256.update(chunk);
    sha512.update(chunk);
  }
  if (size === 0) throw new Error(`${basename(filePath)} is empty.`);
  return {
    name: basename(filePath),
    size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
  };
}

function sha256Base64(hexDigest) {
  return Buffer.from(hexDigest, "hex").toString("base64");
}

function expectedChecksumText(evidenceByName, version) {
  const prefix = `Relayer-${version}-mac-arm64`;
  return [`${prefix}.dmg`, `${prefix}.zip`]
    .map((name) => `${evidenceByName.get(name)?.sha256 || ""}  ${name}`)
    .join("\n");
}

export function validatePreviewPublicationProvenance(environment, version) {
  const sourceCommit = String(environment.GITHUB_SHA || "").trim().toLowerCase();
  const refName = String(environment.GITHUB_REF_NAME || "").trim();
  const workflowRunId = String(environment.GITHUB_RUN_ID || "").trim();
  const workflowRunAttempt = String(environment.GITHUB_RUN_ATTEMPT || "").trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("Preview publication requires a full GitHub source commit SHA.");
  }
  if (refName !== `desktop-v${version}`) {
    throw new Error(`Preview publication requires tag desktop-v${version}.`);
  }
  if (!/^\d+$/.test(workflowRunId) || !/^\d+$/.test(workflowRunAttempt)) {
    throw new Error("Preview publication requires numeric GitHub run identity.");
  }
  return { sourceCommit, workflowRunId, workflowRunAttempt };
}

export function preparePreviewManifest({ manifestText, version, artifactEvidence } = {}) {
  const manifest = parseYaml(manifestText);
  if (!manifest || !isNumericVersion(manifest.version) || String(manifest.version) !== version) {
    throw new Error("Preview manifest version does not match the desktop version.");
  }
  const expectedNames = [
    `Relayer-${version}-mac-arm64.zip`,
    `Relayer-${version}-mac-arm64.dmg`,
  ];
  const evidenceByName = new Map(artifactEvidence.map((item) => [item.name, item]));
  if (!Array.isArray(manifest.files) || manifest.files.length !== expectedNames.length) {
    throw new Error("Preview manifest must contain exactly the update ZIP and DMG.");
  }
  for (const expectedName of expectedNames) {
    const file = manifest.files.find((candidate) => candidate?.url === expectedName);
    const evidence = evidenceByName.get(expectedName);
    const blockmap = evidenceByName.get(`${expectedName}.blockmap`);
    if (
      !file ||
      !evidence ||
      !blockmap ||
      file.sha512 !== evidence.sha512 ||
      Number(file.size) !== evidence.size ||
      Number(file.blockMapSize) !== blockmap.size
    ) {
      throw new Error(`Preview manifest does not seal ${expectedName} and its blockmap.`);
    }
    file.url = `releases/${version}/${expectedName}`;
  }
  const zipName = expectedNames[0];
  const zip = evidenceByName.get(zipName);
  if (manifest.path !== zipName || manifest.sha512 !== zip.sha512) {
    throw new Error("Preview manifest legacy ZIP identity is invalid.");
  }
  manifest.path = `releases/${version}/${zipName}`;
  return stringifyYaml(manifest);
}

export function createPreviewPublicationPlan({ version, evidence } = {}) {
  const releasePrefix = `${PUBLIC_PREFIX}/releases/${version}`;
  return evidence.map((artifact) => ({
    ...artifact,
    key: `${releasePrefix}/${artifact.name}`,
    contentType: contentType(artifact.name),
    cacheControl: IMMUTABLE_CACHE_CONTROL,
  }));
}

export function classifyPreviewPointer({ currentVersion, currentContent, version, manifestText } = {}) {
  if (currentVersion && currentVersion !== version && compareNumericVersions(version, currentVersion) <= 0) {
    throw new Error(`Preview ${version} must be newer than live Preview ${currentVersion}.`);
  }
  if (currentVersion === version && currentContent !== manifestText) {
    throw new Error(`Live Preview ${version} cannot be replaced with different artifact bytes.`);
  }
  return { recovery: currentVersion === version && currentContent === manifestText };
}

export function validatePreviewCandidate({
  releaseReceipt,
  checksumText,
  version,
  sourceCommit,
  artifactEvidence,
} = {}) {
  const evidenceByName = new Map(artifactEvidence.map((item) => [item.name, item]));
  const prefix = `Relayer-${version}-mac-arm64`;
  const signedArtifacts = [`${prefix}.dmg`, `${prefix}.zip`].map((name) => evidenceByName.get(name));
  if (signedArtifacts.some((item) => !item)) {
    throw new Error("Preview candidate is missing its signed DMG or update ZIP.");
  }
  if (
    releaseReceipt?.schemaVersion !== 1 ||
    releaseReceipt.product !== DESKTOP_RELEASE.productName ||
    releaseReceipt.version !== version ||
    releaseReceipt.channel !== "preview" ||
    releaseReceipt.manifest !== "beta-mac.yml" ||
    releaseReceipt.sourceCommit !== sourceCommit ||
    releaseReceipt.appId !== DESKTOP_RELEASE.productionAppId ||
    releaseReceipt.architecture !== DESKTOP_RELEASE.architecture ||
    releaseReceipt.minimumMacOSVersion !== DESKTOP_RELEASE.minimumMacOSVersion ||
    releaseReceipt.updateBaseUrl !== DESKTOP_RELEASE.updateBaseUrl ||
    releaseReceipt.appleTeamId !== DESKTOP_RELEASE.appleTeamId ||
    JSON.stringify(releaseReceipt.artifacts) !== JSON.stringify(signedArtifacts)
  ) {
    throw new Error("Signed release receipt does not match Preview publication provenance and bytes.");
  }
  if (checksumText.trim() !== expectedChecksumText(evidenceByName, version)) {
    throw new Error("Preview checksum manifest does not match the signed DMG and update ZIP.");
  }
}

export function buildPutObjectArgs({
  bucket,
  key,
  filePath,
  evidence,
  ifNoneMatch = false,
  ifMatch = null,
  cacheControl,
  sourceCommit,
} = {}) {
  const args = [
    "s3api", "put-object",
    "--bucket", bucket,
    "--key", key,
    "--body", filePath,
    "--server-side-encryption", "AES256",
    "--checksum-sha256", sha256Base64(evidence.sha256),
    "--content-type", contentType(key),
    "--cache-control", cacheControl,
    "--metadata", `sha256=${evidence.sha256},sourcecommit=${sourceCommit}`,
  ];
  if (ifNoneMatch) args.push("--if-none-match", "*");
  if (ifMatch) args.push("--if-match", ifMatch);
  return args;
}

async function runAws(args, execute = execFileAsync) {
  const result = await execute("aws", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return String(result.stdout || "");
}

async function headObject({ bucket, key, execute = execFileAsync } = {}) {
  try {
    return JSON.parse(await runAws([
      "s3api", "head-object", "--bucket", bucket, "--key", key, "--checksum-mode", "ENABLED", "--output", "json",
    ], execute));
  } catch (error) {
    const details = `${error?.stdout || ""}\n${error?.stderr || ""}`;
    if (/Not Found|404|NoSuchKey/i.test(details)) return null;
    throw error;
  }
}

async function ensureImmutableObject({ bucket, key, filePath, evidence, sourceCommit, execute } = {}) {
  const existing = await headObject({ bucket, key, execute });
  if (existing) {
    if (
      Number(existing.ContentLength) !== evidence.size ||
      existing.Metadata?.sha256 !== evidence.sha256 ||
      existing.Metadata?.sourcecommit !== sourceCommit ||
      (existing.ChecksumSHA256 && existing.ChecksumSHA256 !== sha256Base64(evidence.sha256))
    ) {
      throw new Error(`Immutable update object ${key} already exists with different evidence.`);
    }
    return { key, reused: true };
  }
  await runAws(buildPutObjectArgs({
    bucket,
    key,
    filePath,
    evidence,
    ifNoneMatch: true,
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    sourceCommit,
  }), execute);
  return { key, reused: false };
}

async function readObject({ bucket, key, execute = execFileAsync } = {}) {
  const head = await headObject({ bucket, key, execute });
  if (!head) return null;
  const directory = await mkdtemp(join(tmpdir(), "relayer-release-object-"));
  const target = join(directory, "object");
  try {
    await runAws(["s3api", "get-object", "--bucket", bucket, "--key", key, target], execute);
    return { head, content: await readFile(target, "utf8") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readPointer({ bucket, key, execute = execFileAsync } = {}) {
  const object = await readObject({ bucket, key, execute });
  if (!object) return { etag: null, version: null, content: null };
  const parsed = parseYaml(object.content);
  if (!isNumericVersion(parsed?.version)) throw new Error("Existing Preview pointer has an invalid version.");
  return { etag: String(object.head.ETag || ""), version: String(parsed.version), content: object.content };
}

async function movePreviewPointer({ bucket, filePath, evidence, sourceCommit, current, execute } = {}) {
  await runAws(buildPutObjectArgs({
    bucket,
    key: `${PUBLIC_PREFIX}/beta-mac.yml`,
    filePath,
    evidence,
    ifNoneMatch: !current.etag,
    ifMatch: current.etag,
    cacheControl: POINTER_CACHE_CONTROL,
    sourceCommit,
  }), execute);
}

async function verifyPublicObject({ url, evidence, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    cache: "no-store",
    redirect: "error",
    headers: { "Accept-Encoding": "identity" },
  });
  if (!response.ok || !response.body?.getReader) {
    throw new Error(`Public update object is unavailable: ${url}`);
  }
  const sha256 = createHash("sha256");
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    sha256.update(value);
  }
  if (size !== evidence.size || sha256.digest("hex") !== evidence.sha256) {
    throw new Error(`Public update object bytes do not match: ${url}`);
  }
}

export async function publishDesktopPreview({
  bucket,
  baseUrl = DESKTOP_RELEASE.updateBaseUrl,
  distRoot = resolve(import.meta.dirname, "../dist"),
  environment = process.env,
  execute = execFileAsync,
  fetchImpl = fetch,
} = {}) {
  if (!bucket) throw new Error("Preview publication requires an S3 bucket.");
  if (baseUrl !== DESKTOP_RELEASE.updateBaseUrl) throw new Error("Preview publication base URL is not sealed.");
  const packageMetadata = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"));
  const version = String(packageMetadata.version || "").trim();
  if (!isNumericVersion(version)) throw new Error("Desktop version must be numeric major.minor.patch.");
  const provenance = validatePreviewPublicationProvenance(environment, version);

  const prefix = `Relayer-${version}-mac-arm64`;
  const artifactNames = [
    `${prefix}.dmg`,
    `${prefix}.dmg.blockmap`,
    `${prefix}.zip`,
    `${prefix}.zip.blockmap`,
    `${prefix}-SHA256SUMS.txt`,
    `${prefix}-RELEASE.json`,
  ];
  const presentPrefixedNames = (await readdir(distRoot)).filter((name) => name.startsWith(prefix));
  const unexpected = presentPrefixedNames.filter((name) => !artifactNames.includes(name));
  const missing = artifactNames.filter((name) => !presentPrefixedNames.includes(name));
  if (unexpected.length || missing.length) {
    throw new Error(`Preview candidate artifact set mismatch; missing=${missing.join(",")}; unexpected=${unexpected.join(",")}.`);
  }
  const evidence = await Promise.all(artifactNames.map((name) => fileEvidence(join(distRoot, name))));
  const releaseReceipt = JSON.parse(await readFile(join(distRoot, `${prefix}-RELEASE.json`), "utf8"));
  validatePreviewCandidate({
    releaseReceipt,
    checksumText: await readFile(join(distRoot, `${prefix}-SHA256SUMS.txt`), "utf8"),
    version,
    sourceCommit: provenance.sourceCommit,
    artifactEvidence: evidence,
  });

  const manifestText = preparePreviewManifest({
    manifestText: await readFile(join(distRoot, "beta-mac.yml"), "utf8"),
    version,
    artifactEvidence: evidence,
  });
  const preparedManifestPath = join(distRoot, `publish-beta-${randomUUID()}.yml`);
  await writeFile(preparedManifestPath, manifestText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    const manifestEvidence = await fileEvidence(preparedManifestPath);
    const plan = createPreviewPublicationPlan({ version, evidence });
    const current = await readPointer({ bucket, key: `${PUBLIC_PREFIX}/beta-mac.yml`, execute });
    const { recovery } = classifyPreviewPointer({
      currentVersion: current.version,
      currentContent: current.content,
      version,
      manifestText,
    });

    for (const item of plan) {
      await ensureImmutableObject({
        bucket,
        key: item.key,
        filePath: join(distRoot, item.name),
        evidence: item,
        sourceCommit: provenance.sourceCommit,
        execute,
      });
    }
    const historyKey = `private/history/beta/${version}/beta-mac.yml`;
    await ensureImmutableObject({
      bucket,
      key: historyKey,
      filePath: preparedManifestPath,
      evidence: { ...manifestEvidence, name: "beta-mac.yml" },
      sourceCommit: provenance.sourceCommit,
      execute,
    });

    for (const item of plan) {
      await verifyPublicObject({
        url: `${baseUrl}/releases/${version}/${item.name}`,
        evidence: item,
        fetchImpl,
      });
    }
    if (!recovery) {
      await movePreviewPointer({
        bucket,
        filePath: preparedManifestPath,
        evidence: manifestEvidence,
        sourceCommit: provenance.sourceCommit,
        current,
        execute,
      });
    }
    await verifyPublicObject({
      url: `${baseUrl}/beta-mac.yml?noCache=${Date.now().toString(32)}`,
      evidence: manifestEvidence,
      fetchImpl,
    });

    const receiptKey = `private/receipts/preview/${version}.json`;
    const existingReceiptObject = await readObject({ bucket, key: receiptKey, execute });
    let receipt = {
      schemaVersion: 1,
      channel: "preview",
      version,
      sourceCommit: provenance.sourceCommit,
      workflowRunId: provenance.workflowRunId,
      workflowRunAttempt: provenance.workflowRunAttempt,
      publishedAt: new Date().toISOString(),
      artifacts: plan.map(({ name, size, sha256, sha512, key }) => ({ name, size, sha256, sha512, key })),
      manifest: { key: `${PUBLIC_PREFIX}/beta-mac.yml`, size: manifestEvidence.size, sha256: manifestEvidence.sha256 },
    };
    if (existingReceiptObject) {
      const existingReceipt = JSON.parse(existingReceiptObject.content);
      const expectedIdentity = {
        channel: receipt.channel,
        version: receipt.version,
        sourceCommit: receipt.sourceCommit,
        artifacts: receipt.artifacts,
        manifest: receipt.manifest,
      };
      const existingIdentity = {
        channel: existingReceipt.channel,
        version: existingReceipt.version,
        sourceCommit: existingReceipt.sourceCommit,
        artifacts: existingReceipt.artifacts,
        manifest: existingReceipt.manifest,
      };
      if (JSON.stringify(existingIdentity) !== JSON.stringify(expectedIdentity)) {
        throw new Error(`Preview ${version} already has a different publication receipt.`);
      }
      receipt = existingReceipt;
    }
    const receiptPath = join(distRoot, `preview-publication-${version}.json`);
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (!existingReceiptObject) {
      const receiptEvidence = await fileEvidence(receiptPath);
      await ensureImmutableObject({
        bucket,
        key: receiptKey,
        filePath: receiptPath,
        evidence: receiptEvidence,
        sourceCommit: provenance.sourceCommit,
        execute,
      });
    }
    return { receiptPath, receipt };
  } finally {
    await rm(preparedManifestPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bucketIndex = process.argv.indexOf("--bucket");
  const bucket = bucketIndex >= 0 ? process.argv[bucketIndex + 1] : "";
  const result = await publishDesktopPreview({ bucket });
  console.log(JSON.stringify({ ok: true, receiptPath: result.receiptPath }, null, 2));
}
