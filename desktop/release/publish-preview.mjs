import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { DESKTOP_RELEASE, desktopReleaseTarget } from "./contract.mjs";
import { compareNumericVersions, isNumericVersion } from "./numeric-version.mjs";
import { RELEASE_MANAGED_RUNTIME_REQUIREMENTS } from "../shared/managed-runtime-requirements.mjs";

const execFileAsync = promisify(execFile);
const IMMUTABLE_CACHE_CONTROL = "public,max-age=31536000,immutable";
const POINTER_CACHE_CONTROL = "no-store,no-cache,must-revalidate,max-age=0";
const AMBIGUOUS_HEAD = Symbol("ambiguous-head");
const CONDITIONAL_WRITE_ATTEMPTS = 3;

function contentType(name) {
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
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

function releaseArtifactNames(target, version) {
  const prefix = `Relayer-${version}-${target.format}-${target.architecture}`;
  return {
    prefix,
    primary: target.platform === "darwin" ? [`${prefix}.dmg`, `${prefix}.zip`] : [`${prefix}.exe`],
  };
}

function expectedChecksumText(evidenceByName, target, version) {
  const { primary } = releaseArtifactNames(target, version);
  return primary
    .map((name) => `${evidenceByName.get(name)?.sha256 || ""}  ${name}`)
    .join("\n");
}

export function validatePreviewPublicationProvenance(environment, version) {
  const sourceCommit = String(environment.GITHUB_SHA || "").trim().toLowerCase();
  const refName = String(environment.GITHUB_REF_NAME || "").trim();
  const workflowRunId = String(environment.GITHUB_RUN_ID || "").trim();
  const workflowRunAttempt = String(environment.GITHUB_RUN_ATTEMPT || "").trim();
  const candidateWorkflowRunId = String(environment.RELAYER_DESKTOP_CANDIDATE_RUN_ID || "").trim();
  const candidateWorkflowRunAttempt = String(environment.RELAYER_DESKTOP_CANDIDATE_RUN_ATTEMPT || "").trim();
  const candidateArtifactId = String(environment.RELAYER_DESKTOP_CANDIDATE_ARTIFACT_ID || "").trim();
  const candidateArtifactDigest = String(environment.RELAYER_DESKTOP_CANDIDATE_ARTIFACT_DIGEST || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    throw new Error("Preview publication requires a full GitHub source commit SHA.");
  }
  if (refName !== `desktop-v${version}`) {
    throw new Error(`Preview publication requires tag desktop-v${version}.`);
  }
  if (
    !/^[1-9]\d*$/.test(workflowRunId) ||
    !/^[1-9]\d*$/.test(workflowRunAttempt) ||
    !/^[1-9]\d*$/.test(candidateWorkflowRunId) ||
    !/^[1-9]\d*$/.test(candidateWorkflowRunAttempt) ||
    !/^[1-9]\d*$/.test(candidateArtifactId) ||
    !/^sha256:[a-f0-9]{64}$/.test(candidateArtifactDigest)
  ) {
    throw new Error("Preview publication requires numeric publication and candidate workflow identities.");
  }
  return {
    sourceCommit,
    workflowRunId,
    workflowRunAttempt,
    candidateWorkflowRunId,
    candidateWorkflowRunAttempt,
    candidateArtifactId,
    candidateArtifactDigest,
  };
}

export function preparePreviewManifest({ manifestText, version, artifactEvidence, target = desktopReleaseTarget() } = {}) {
  const manifest = parseYaml(manifestText);
  if (!manifest || !isNumericVersion(manifest.version) || String(manifest.version) !== version) {
    throw new Error("Preview manifest version does not match the desktop version.");
  }
  if (target.platform === "darwin") {
    if (manifest.minimumSystemVersion !== target.minimumUpdateSystemVersion) {
      throw new Error("Preview manifest minimum system version does not match the desktop release target.");
    }
  } else if (manifest.minimumSystemVersion != null) {
    throw new Error("Windows Preview manifest must not declare a macOS minimum system version.");
  }
  const expectedNames = releaseArtifactNames(target, version).primary;
  const evidenceByName = new Map(artifactEvidence.map((item) => [item.name, item]));
  if (!Array.isArray(manifest.files) || manifest.files.length !== expectedNames.length) {
    throw new Error(`Preview manifest must contain exactly ${expectedNames.length} release artifact(s).`);
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
  const updateName = target.platform === "darwin"
    ? expectedNames.find((name) => name.endsWith(".zip"))
    : expectedNames.find((name) => name.endsWith(".exe"));
  const updateArtifact = evidenceByName.get(updateName);
  if (manifest.path !== updateName || manifest.sha512 !== updateArtifact.sha512) {
    throw new Error("Preview manifest legacy update identity is invalid.");
  }
  manifest.path = `releases/${version}/${updateName}`;
  manifest.relayerManagedRuntimes = RELEASE_MANAGED_RUNTIME_REQUIREMENTS;
  return stringifyYaml(manifest);
}

export function createPreviewPublicationPlan({ version, evidence, target = desktopReleaseTarget() } = {}) {
  const releasePrefix = `${target.publicPrefix}/releases/${version}`;
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
  target = desktopReleaseTarget(),
} = {}) {
  const evidenceByName = new Map(artifactEvidence.map((item) => [item.name, item]));
  const signedArtifacts = releaseArtifactNames(target, version).primary.map((name) => evidenceByName.get(name));
  if (signedArtifacts.some((item) => !item)) {
    throw new Error("Preview candidate is missing one or more signed release artifacts.");
  }
  const signingMatches = target.platform === "darwin"
    ? releaseReceipt?.signing?.mode &&
      releaseReceipt.signing.appleTeamId === DESKTOP_RELEASE.appleTeamId &&
      releaseReceipt.signing.notarizationMode !== "disabled"
    : releaseReceipt?.signing?.mode === "azure-artifact-signing" &&
      releaseReceipt.signing.endpoint === DESKTOP_RELEASE.artifactSigningEndpoint &&
      releaseReceipt.signing.accountName === DESKTOP_RELEASE.artifactSigningAccountName &&
      Boolean(releaseReceipt.signing.certificateProfileName) &&
      Boolean(releaseReceipt.signing.publisherName);
  if (
    releaseReceipt?.schemaVersion !== 2 ||
    releaseReceipt.product !== DESKTOP_RELEASE.productName ||
    releaseReceipt.version !== version ||
    releaseReceipt.target !== target.key ||
    releaseReceipt.platform !== target.distributionPlatform ||
    releaseReceipt.channel !== "preview" ||
    releaseReceipt.manifest !== target.channels.preview.manifestName ||
    releaseReceipt.sourceCommit !== sourceCommit ||
    releaseReceipt.appId !== DESKTOP_RELEASE.productionAppId ||
    releaseReceipt.architecture !== target.architecture ||
    releaseReceipt.minimumMacOSVersion !== target.minimumMacOSVersion ||
    releaseReceipt.updateBaseUrl !== target.updateBaseUrl ||
    !signingMatches ||
    JSON.stringify(releaseReceipt.artifacts) !== JSON.stringify(signedArtifacts)
  ) {
    throw new Error("Signed release receipt does not match Preview publication provenance and bytes.");
  }
  if (checksumText.trim() !== expectedChecksumText(evidenceByName, target, version)) {
    throw new Error("Preview checksum manifest does not match the signed release artifacts.");
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

function awsErrorDetails(error) {
  return `${error?.message || ""}\n${error?.stdout || ""}\n${error?.stderr || ""}`;
}

function isMissingObjectError(error) {
  return /Not Found|\b404\b|NoSuchKey/i.test(awsErrorDetails(error));
}

function isAmbiguousHeadError(error) {
  return /Forbidden|AccessDenied|\b403\b/i.test(awsErrorDetails(error));
}

function isPreconditionError(error) {
  return /PreconditionFailed|\b412\b/i.test(awsErrorDetails(error));
}

function isConditionalConflict(error) {
  return /ConditionalRequestConflict|\b409\b/i.test(awsErrorDetails(error));
}

async function headObject({ bucket, key, execute = execFileAsync } = {}) {
  try {
    return JSON.parse(await runAws([
      "s3api", "head-object", "--bucket", bucket, "--key", key, "--checksum-mode", "ENABLED", "--output", "json",
    ], execute));
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    // S3 returns 403 for an absent object when the role intentionally lacks
    // ListBucket. A conditional write, not this HEAD result, decides absence.
    if (isAmbiguousHeadError(error)) return AMBIGUOUS_HEAD;
    throw error;
  }
}

function validateImmutableObject({ existing, key, evidence, sourceCommit } = {}) {
  if (
    Number(existing.ContentLength) !== evidence.size ||
    existing.Metadata?.sha256 !== evidence.sha256 ||
    existing.Metadata?.sourcecommit !== sourceCommit ||
    (existing.ChecksumSHA256 && existing.ChecksumSHA256 !== sha256Base64(evidence.sha256))
  ) {
    throw new Error(`Immutable update object ${key} already exists with different evidence.`);
  }
}

async function ensureImmutableObject({ bucket, key, filePath, evidence, sourceCommit, execute } = {}) {
  const existing = await headObject({ bucket, key, execute });
  if (existing && existing !== AMBIGUOUS_HEAD) {
    validateImmutableObject({ existing, key, evidence, sourceCommit });
    return { key, reused: true };
  }
  for (let attempt = 1; attempt <= CONDITIONAL_WRITE_ATTEMPTS; attempt += 1) {
    try {
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
    } catch (error) {
      if (isPreconditionError(error)) {
        const racedObject = await headObject({ bucket, key, execute });
        if (racedObject && racedObject !== AMBIGUOUS_HEAD) {
          validateImmutableObject({ existing: racedObject, key, evidence, sourceCommit });
          return { key, reused: true };
        }
        if (racedObject === AMBIGUOUS_HEAD) {
          throw new Error(`Immutable update object ${key} exists but cannot be read for validation.`, { cause: error });
        }
      } else if (!isConditionalConflict(error)) {
        throw error;
      }
      if (attempt === CONDITIONAL_WRITE_ATTEMPTS) throw error;
    }
  }
  throw new Error(`Immutable update object ${key} could not be written conditionally.`);
}

async function readObject({ bucket, key, execute = execFileAsync } = {}) {
  const head = await headObject({ bucket, key, execute });
  if (!head || head === AMBIGUOUS_HEAD) return null;
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

async function movePreviewPointer({ bucket, filePath, evidence, sourceCommit, current, execute, target } = {}) {
  await runAws(buildPutObjectArgs({
    bucket,
    key: `${target.publicPrefix}/${target.channels.preview.manifestName}`,
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
  target = desktopReleaseTarget(String(process.env.RELAYER_DESKTOP_TARGET || "macos-arm64")),
  baseUrl = target.updateBaseUrl,
  distRoot = resolve(import.meta.dirname, "../dist"),
  environment = process.env,
  execute = execFileAsync,
  fetchImpl = fetch,
} = {}) {
  if (!bucket) throw new Error("Preview publication requires an S3 bucket.");
  if (baseUrl !== target.updateBaseUrl) throw new Error("Preview publication base URL is not sealed.");
  const packageMetadata = JSON.parse(await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"));
  const version = String(packageMetadata.version || "").trim();
  if (!isNumericVersion(version)) throw new Error("Desktop version must be numeric major.minor.patch.");
  const provenance = validatePreviewPublicationProvenance(environment, version);

  const { prefix, primary } = releaseArtifactNames(target, version);
  const artifactNames = [
    ...primary,
    ...primary.map((name) => `${name}.blockmap`),
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
    target,
  });

  const manifestName = target.channels.preview.manifestName;
  const manifestText = preparePreviewManifest({
    manifestText: await readFile(join(distRoot, manifestName), "utf8"),
    version,
    artifactEvidence: evidence,
    target,
  });
  const preparedManifestPath = join(distRoot, `publish-${target.key}-beta-${randomUUID()}.yml`);
  await writeFile(preparedManifestPath, manifestText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    const manifestEvidence = await fileEvidence(preparedManifestPath);
    const plan = createPreviewPublicationPlan({ version, evidence, target });
    const pointerKey = `${target.publicPrefix}/${manifestName}`;
    const current = await readPointer({ bucket, key: pointerKey, execute });
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
    const historyKey = `private/history/${target.key}/beta/${version}/${manifestName}`;
    await ensureImmutableObject({
      bucket,
      key: historyKey,
      filePath: preparedManifestPath,
      evidence: { ...manifestEvidence, name: manifestName },
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
        target,
      });
    }
    await verifyPublicObject({
      url: `${baseUrl}/${manifestName}?noCache=${Date.now().toString(32)}`,
      evidence: manifestEvidence,
      fetchImpl,
    });

    const receiptKey = `private/receipts/${target.key}/preview/${version}.json`;
    const existingReceiptObject = await readObject({ bucket, key: receiptKey, execute });
    let receipt = {
      schemaVersion: 2,
      channel: "preview",
      target: target.key,
      version,
      sourceCommit: provenance.sourceCommit,
      candidateWorkflowRunId: provenance.candidateWorkflowRunId,
      candidateWorkflowRunAttempt: provenance.candidateWorkflowRunAttempt,
      candidateArtifactId: provenance.candidateArtifactId,
      candidateArtifactDigest: provenance.candidateArtifactDigest,
      workflowRunId: provenance.workflowRunId,
      workflowRunAttempt: provenance.workflowRunAttempt,
      publishedAt: new Date().toISOString(),
      artifacts: plan.map(({ name, size, sha256, sha512, key }) => ({ name, size, sha256, sha512, key })),
      manifest: { key: pointerKey, size: manifestEvidence.size, sha256: manifestEvidence.sha256 },
    };
    if (existingReceiptObject) {
      const existingReceipt = JSON.parse(existingReceiptObject.content);
      const expectedIdentity = {
        channel: receipt.channel,
        target: receipt.target,
        version: receipt.version,
        sourceCommit: receipt.sourceCommit,
        candidateWorkflowRunId: receipt.candidateWorkflowRunId,
        candidateWorkflowRunAttempt: receipt.candidateWorkflowRunAttempt,
        candidateArtifactId: receipt.candidateArtifactId,
        candidateArtifactDigest: receipt.candidateArtifactDigest,
        artifacts: receipt.artifacts,
        manifest: receipt.manifest,
      };
      const existingIdentity = {
        channel: existingReceipt.channel,
        target: existingReceipt.target,
        version: existingReceipt.version,
        sourceCommit: existingReceipt.sourceCommit,
        candidateWorkflowRunId: existingReceipt.candidateWorkflowRunId,
        candidateWorkflowRunAttempt: existingReceipt.candidateWorkflowRunAttempt,
        candidateArtifactId: existingReceipt.candidateArtifactId,
        candidateArtifactDigest: existingReceipt.candidateArtifactDigest,
        artifacts: existingReceipt.artifacts,
        manifest: existingReceipt.manifest,
      };
      if (JSON.stringify(existingIdentity) !== JSON.stringify(expectedIdentity)) {
        throw new Error(`Preview ${version} already has a different publication receipt.`);
      }
      receipt = existingReceipt;
    }
    const receiptPath = join(distRoot, `preview-publication-${target.key}-${version}.json`);
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
