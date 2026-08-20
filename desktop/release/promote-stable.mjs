import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parse as parseYaml } from "yaml";

import { desktopReleaseTarget } from "./contract.mjs";
import { deriveDesktopCanaryTrace } from "./canary-evidence.mjs";
import { compareNumericVersions, isNumericVersion } from "./numeric-version.mjs";
import { buildPutObjectArgs } from "./publish-preview.mjs";

const execFileAsync = promisify(execFile);
const POINTER_CACHE_CONTROL = "no-store,no-cache,must-revalidate,max-age=0";
const IMMUTABLE_CACHE_CONTROL = "private,max-age=31536000,immutable";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function sha256Base64(hexDigest) {
  return Buffer.from(hexDigest, "hex").toString("base64");
}

async function fileEvidence(filePath) {
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    size += chunk.length;
    digest.update(chunk);
  }
  if (size === 0) throw new Error(`${basename(filePath)} is empty.`);
  return { size, sha256: digest.digest("hex") };
}

async function runAws(args, execute = execFileAsync) {
  const result = await execute("aws", args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return String(result.stdout || "");
}

async function objectExists({ bucket, key, execute = execFileAsync } = {}) {
  const result = JSON.parse(await runAws([
    "s3api", "list-objects-v2", "--bucket", bucket, "--prefix", key, "--max-keys", "1", "--output", "json",
  ], execute));
  return Array.isArray(result.Contents) && result.Contents.some((object) => object?.Key === key);
}

async function headObject({ bucket, key, execute = execFileAsync } = {}) {
  if (!await objectExists({ bucket, key, execute })) return null;
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

async function readObject({ bucket, key, execute = execFileAsync, required = true } = {}) {
  const head = await headObject({ bucket, key, execute });
  if (!head) {
    if (required) throw new Error(`Required release object is missing: ${key}`);
    return null;
  }
  const directory = await mkdtemp(join(tmpdir(), "relayer-stable-object-"));
  const target = join(directory, "object");
  try {
    await runAws(["s3api", "get-object", "--bucket", bucket, "--key", key, target], execute);
    const content = await readFile(target);
    return { head, content, text: content.toString("utf8"), sha256: sha256(content) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function releaseArtifactNames(target, version) {
  const prefix = `Relayer-${version}-${target.format}-${target.architecture}`;
  const primary = target.platform === "darwin" ? [`${prefix}.dmg`, `${prefix}.zip`] : [`${prefix}.exe`];
  return {
    prefix,
    primary,
    complete: [...primary, ...primary.map((name) => `${name}.blockmap`), `${prefix}-SHA256SUMS.txt`, `${prefix}-RELEASE.json`],
  };
}

async function readPointer({ bucket, target, execute = execFileAsync } = {}) {
  const object = await readObject({
    bucket,
    key: `${target.publicPrefix}/${target.channels.stable.manifestName}`,
    execute,
    required: false,
  });
  if (!object) return { etag: null, version: null, text: null, sha256: null };
  const parsed = parseYaml(object.text);
  if (!isNumericVersion(parsed?.version)) throw new Error("Existing Stable pointer has an invalid version.");
  return {
    etag: String(object.head.ETag || ""),
    version: String(parsed.version),
    text: object.text,
    sha256: object.sha256,
  };
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
      throw new Error(`Immutable Stable object ${key} already exists with different evidence.`);
    }
    return { reused: true };
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
  return { reused: false };
}

async function moveStablePointer({ bucket, filePath, evidence, sourceCommit, current, execute, target } = {}) {
  await runAws(buildPutObjectArgs({
    bucket,
    key: `${target.publicPrefix}/${target.channels.stable.manifestName}`,
    filePath,
    evidence,
    ifNoneMatch: !current.etag,
    ifMatch: current.etag,
    cacheControl: POINTER_CACHE_CONTROL,
    sourceCommit,
  }), execute);
}

async function verifyPublicObject({ url, expected, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    cache: "no-store",
    redirect: "error",
    headers: { "Accept-Encoding": "identity" },
  });
  if (!response.ok || !response.body?.getReader) throw new Error(`Public Stable object is unavailable: ${url}`);
  const digest = createHash("sha256");
  let size = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    digest.update(value);
  }
  if (size !== expected.size || digest.digest("hex") !== expected.sha256) {
    throw new Error(`Public Stable object bytes do not match: ${url}`);
  }
}

export function validateStablePromotionProvenance(environment, version, targetKey = "macos-arm64") {
  const workflowCommit = String(environment.GITHUB_SHA || "").trim().toLowerCase();
  const workflowRunId = String(environment.GITHUB_RUN_ID || "").trim();
  const workflowRunAttempt = String(environment.GITHUB_RUN_ATTEMPT || "").trim();
  const actor = String(environment.GITHUB_ACTOR || "").trim();
  const confirmation = String(environment.STABLE_PROMOTION_CONFIRMATION || "").trim();
  if (environment.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Stable promotion must run from main.");
  }
  if (!/^[a-f0-9]{40}$/.test(workflowCommit)) {
    throw new Error("Stable promotion requires a full GitHub workflow commit SHA.");
  }
  if (!/^\d+$/.test(workflowRunId) || !/^\d+$/.test(workflowRunAttempt) || !actor) {
    throw new Error("Stable promotion requires GitHub run identity and actor.");
  }
  if (confirmation !== `promote-${targetKey}-${version}`) {
    throw new Error(`Stable promotion confirmation must be promote-${targetKey}-${version}.`);
  }
  return { workflowCommit, workflowRunId, workflowRunAttempt, actor };
}

export function validateStableCandidate({ version, previewReceipt, previewReceiptSha256, manifestText, target = desktopReleaseTarget() } = {}) {
  if (!isNumericVersion(version)) throw new Error("Stable version must be numeric major.minor.patch.");
  const { primary, complete: expectedNames } = releaseArtifactNames(target, version);
  if (
    previewReceipt?.schemaVersion !== 2 ||
    previewReceipt.channel !== "preview" ||
    previewReceipt.target !== target.key ||
    previewReceipt.version !== version ||
    !/^[a-f0-9]{40}$/.test(previewReceipt.sourceCommit || "") ||
    !/^[a-f0-9]{64}$/.test(previewReceiptSha256 || "") ||
    previewReceipt.manifest?.key !== `${target.publicPrefix}/${target.channels.preview.manifestName}` ||
    !Array.isArray(previewReceipt.artifacts) ||
    previewReceipt.artifacts.length !== expectedNames.length
  ) {
    throw new Error("Stable promotion requires one valid immutable Preview receipt.");
  }
  const artifacts = [...previewReceipt.artifacts].sort((a, b) => a.name.localeCompare(b.name));
  if (JSON.stringify(artifacts.map((item) => item.name)) !== JSON.stringify([...expectedNames].sort())) {
    throw new Error("Preview receipt artifact set is not exact.");
  }
  for (const item of artifacts) {
    if (
      item.key !== `${target.publicPrefix}/releases/${version}/${item.name}` ||
      !Number.isInteger(item.size) || item.size <= 0 ||
      !/^[a-f0-9]{64}$/.test(item.sha256 || "") ||
      typeof item.sha512 !== "string" || !item.sha512
    ) {
      throw new Error(`Preview receipt artifact evidence is invalid for ${item.name}.`);
    }
  }
  const manifest = parseYaml(manifestText);
  if (
    String(manifest?.version) !== version ||
    Buffer.byteLength(manifestText) !== previewReceipt.manifest.size ||
    sha256(manifestText) !== previewReceipt.manifest.sha256
  ) {
    throw new Error("Historical Preview manifest does not match its publication receipt.");
  }
  const byName = new Map(artifacts.map((item) => [item.name, item]));
  for (const artifactName of primary) {
    const artifact = byName.get(artifactName);
    const blockmap = byName.get(`${artifactName}.blockmap`);
    const entry = manifest.files?.find((item) => item?.url === `releases/${version}/${artifact.name}`);
    if (
      !entry || entry.sha512 !== artifact.sha512 || Number(entry.size) !== artifact.size ||
      Number(entry.blockMapSize) !== blockmap.size
    ) {
      throw new Error(`Stable manifest does not seal ${artifact.name}.`);
    }
  }
  const updateArtifact = target.platform === "darwin"
    ? byName.get(primary.find((name) => name.endsWith(".zip")))
    : byName.get(primary.find((name) => name.endsWith(".exe")));
  if (manifest.path !== `releases/${version}/${updateArtifact.name}` || manifest.sha512 !== updateArtifact.sha512) {
    throw new Error("Stable manifest legacy update identity is invalid.");
  }
  return { artifacts, sourceCommit: previewReceipt.sourceCommit };
}

export function classifyStablePointer({ currentVersion, currentContent, version, manifestText } = {}) {
  if (currentVersion && currentVersion !== version && compareNumericVersions(version, currentVersion) <= 0) {
    throw new Error(`Stable ${version} must be newer than live Stable ${currentVersion}.`);
  }
  if (currentVersion === version && currentContent !== manifestText) {
    throw new Error(`Live Stable ${version} cannot be replaced with different manifest bytes.`);
  }
  return { recovery: currentVersion === version && currentContent === manifestText };
}

export async function validateCanaryEvidenceFile({ filePath, version, previewReceipt, target = desktopReleaseTarget() } = {}) {
  const content = await readFile(filePath);
  const capture = JSON.parse(content.toString("utf8"));
  const byName = new Map(previewReceipt.artifacts.map((item) => [item.name, item]));
  const primary = releaseArtifactNames(target, version).primary;
  const traceFile = basename(capture.trace?.file || "");
  if (!traceFile || traceFile === basename(filePath) || !/^[a-f0-9]{64}$/.test(capture.trace?.sha256 || "")) {
    throw new Error("Stable promotion canary evidence has invalid trace metadata.");
  }
  const traceContent = await readFile(join(dirname(filePath), traceFile));
  if (sha256(traceContent) !== capture.trace.sha256) {
    throw new Error("Stable promotion canary trace bytes do not match their SHA-256 digest.");
  }
  const derivedTrace = deriveDesktopCanaryTrace({ text: traceContent.toString("utf8"), target, version });
  if (
    capture.schemaVersion !== 2 ||
    !Number.isFinite(Date.parse(capture.capturedAt)) ||
    capture.environment?.target !== target.key ||
    capture.environment?.architecture !== target.architecture ||
    !String(capture.environment?.host || "").trim() ||
    !String(capture.environment?.os || "").trim() ||
    !isNumericVersion(capture.seed?.version) ||
    compareNumericVersions(version, capture.seed.version) <= 0 ||
    !/^[a-f0-9]{40}$/.test(capture.seed?.sourceCommit || "") ||
    capture.target?.version !== version ||
    capture.target?.sourceCommit !== previewReceipt.sourceCommit ||
    String(capture.target?.workflowRunId) !== String(previewReceipt.workflowRunId) ||
    primary.some((name) => capture.target?.artifactSha256?.[name] !== byName.get(name)?.sha256) ||
    capture.trace.records !== derivedTrace.records.length ||
    capture.seed.version !== derivedTrace.seed ||
    capture.seed.processId !== derivedTrace.seedProcessId ||
    capture.postUpdate?.processId !== derivedTrace.targetProcessId ||
    JSON.stringify(capture.productFlow) !== JSON.stringify(derivedTrace.productFlow) ||
    capture.postUpdate?.installedVersion !== version ||
    capture.postUpdate?.running !== true ||
    capture.postUpdate?.codeSignatureVerified !== true ||
    capture.postUpdate?.platformAcceptanceVerified !== true ||
    !Number.isInteger(capture.seed?.processId) || capture.seed.processId <= 0 ||
    !Number.isInteger(capture.postUpdate?.processId) || capture.postUpdate.processId <= 0 ||
    capture.seed.processId === capture.postUpdate.processId ||
    capture.postUpdate?.channel !== "preview" ||
    capture.postUpdate?.updateStatus !== "idle"
  ) {
    throw new Error("Stable promotion canary evidence does not prove the exact Preview candidate.");
  }
  const screenshotNames = ["firstInstall", "available", "ready", "installed"];
  if (screenshotNames.some((name) => !capture.screenshots?.[name])) {
    throw new Error("Stable promotion requires first-install, available, ready, and installed screenshots.");
  }
  const screenshots = screenshotNames.map((name) => capture.screenshots[name]);
  for (const screenshot of screenshots) {
    if (!/^[a-f0-9]{64}$/.test(screenshot?.sha256 || "")) {
      throw new Error("Canary screenshot evidence has an invalid SHA-256 digest.");
    }
    const screenshotPath = join(dirname(filePath), basename(screenshot.file || ""));
    const screenshotContent = await readFile(screenshotPath);
    if (sha256(screenshotContent) !== screenshot.sha256) {
      throw new Error(`Canary screenshot bytes do not match: ${screenshot.file}`);
    }
  }
  return { capture, size: content.length, sha256: sha256(content) };
}

export async function promoteDesktopStable({
  bucket,
  version,
  canaryEvidencePath,
  repositoryRoot = process.cwd(),
  environment = process.env,
  target = desktopReleaseTarget(String(environment.RELAYER_DESKTOP_TARGET || "macos-arm64")),
  baseUrl = target.updateBaseUrl,
  execute = execFileAsync,
  fetchImpl = fetch,
} = {}) {
  if (!bucket) throw new Error("Stable promotion requires an S3 bucket.");
  if (!isNumericVersion(version)) throw new Error("Stable promotion requires --version major.minor.patch.");
  if (!canaryEvidencePath) throw new Error("Stable promotion requires committed canary evidence.");
  if (baseUrl !== target.updateBaseUrl) throw new Error("Stable promotion base URL is not sealed.");
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  const resolvedCanaryEvidencePath = resolve(resolvedRepositoryRoot, canaryEvidencePath);
  const canaryEvidenceRepositoryPath = relative(resolvedRepositoryRoot, resolvedCanaryEvidencePath);
  if (!canaryEvidenceRepositoryPath || canaryEvidenceRepositoryPath.startsWith("..")) {
    throw new Error("Stable promotion canary evidence must be committed inside the repository.");
  }
  const provenance = validateStablePromotionProvenance(environment, version, target.key);
  const previewReceiptKey = `private/receipts/${target.key}/preview/${version}.json`;
  const previewManifestKey = `private/history/${target.key}/beta/${version}/${target.channels.preview.manifestName}`;
  const [previewReceiptObject, previewManifestObject] = await Promise.all([
    readObject({ bucket, key: previewReceiptKey, execute }),
    readObject({ bucket, key: previewManifestKey, execute }),
  ]);
  const previewReceipt = JSON.parse(previewReceiptObject.text);
  const candidate = validateStableCandidate({
    version,
    previewReceipt,
    previewReceiptSha256: previewReceiptObject.sha256,
    manifestText: previewManifestObject.text,
    target,
  });
  const canaryEvidence = await validateCanaryEvidenceFile({
    filePath: resolvedCanaryEvidencePath,
    version,
    previewReceipt,
    target,
  });

  for (const artifact of candidate.artifacts) {
    const remote = await headObject({ bucket, key: artifact.key, execute });
    if (
      !remote || Number(remote.ContentLength) !== artifact.size ||
      remote.Metadata?.sha256 !== artifact.sha256 ||
      remote.Metadata?.sourcecommit !== candidate.sourceCommit ||
      (remote.ChecksumSHA256 && remote.ChecksumSHA256 !== sha256Base64(artifact.sha256))
    ) {
      throw new Error(`Published Preview artifact no longer matches its receipt: ${artifact.name}`);
    }
    await verifyPublicObject({
      url: `${baseUrl}/releases/${version}/${artifact.name}`,
      expected: artifact,
      fetchImpl,
    });
  }

  const current = await readPointer({ bucket, target, execute });
  const { recovery } = classifyStablePointer({
    currentVersion: current.version,
    currentContent: current.text,
    version,
    manifestText: previewManifestObject.text,
  });
  const directory = await mkdtemp(join(tmpdir(), "relayer-stable-promotion-"));
  const manifestPath = join(directory, `stable-${randomUUID()}.yml`);
  const receiptPath = join(directory, `stable-promotion-${target.key}-${version}.json`);
  try {
    await writeFile(manifestPath, previewManifestObject.content, { mode: 0o600, flag: "wx" });
    const manifestEvidence = await fileEvidence(manifestPath);
    const stableManifestName = target.channels.stable.manifestName;
    const historyKey = `private/history/${target.key}/latest/${version}/${stableManifestName}`;
    await ensureImmutableObject({
      bucket,
      key: historyKey,
      filePath: manifestPath,
      evidence: manifestEvidence,
      sourceCommit: candidate.sourceCommit,
      execute,
    });
    if (!recovery) {
      await moveStablePointer({
        bucket,
        filePath: manifestPath,
        evidence: manifestEvidence,
        sourceCommit: candidate.sourceCommit,
        current,
        execute,
        target,
      });
    }
    await verifyPublicObject({
      url: `${baseUrl}/${stableManifestName}?noCache=${Date.now().toString(32)}`,
      expected: manifestEvidence,
      fetchImpl,
    });

    const receiptKey = `private/receipts/${target.key}/stable/${version}.json`;
    const existingReceiptObject = await readObject({ bucket, key: receiptKey, execute, required: false });
    let receipt = {
      schemaVersion: 2,
      channel: "stable",
      target: target.key,
      version,
      sourceCommit: candidate.sourceCommit,
      previewReceipt: { key: previewReceiptKey, sha256: previewReceiptObject.sha256 },
      canaryEvidence: {
        repositoryPath: canaryEvidenceRepositoryPath,
        sha256: canaryEvidence.sha256,
        capturedAt: canaryEvidence.capture.capturedAt,
        seedVersion: canaryEvidence.capture.seed?.version,
      },
      promotion: {
        workflowCommit: provenance.workflowCommit,
        workflowRunId: provenance.workflowRunId,
        workflowRunAttempt: provenance.workflowRunAttempt,
        actor: provenance.actor,
      },
      artifacts: candidate.artifacts,
      manifest: { key: `${target.publicPrefix}/${stableManifestName}`, size: manifestEvidence.size, sha256: manifestEvidence.sha256 },
      promotedAt: new Date().toISOString(),
    };
    if (existingReceiptObject) {
      const existingReceipt = JSON.parse(existingReceiptObject.text);
      const identity = ({ promotedAt: _promotedAt, promotion: _promotion, ...value }) => value;
      if (JSON.stringify(identity(existingReceipt)) !== JSON.stringify(identity(receipt))) {
        throw new Error(`Stable ${version} already has a different promotion receipt.`);
      }
      receipt = existingReceipt;
    }
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    if (!existingReceiptObject) {
      const receiptEvidence = await fileEvidence(receiptPath);
      await ensureImmutableObject({
        bucket,
        key: receiptKey,
        filePath: receiptPath,
        evidence: receiptEvidence,
        sourceCommit: candidate.sourceCommit,
        execute,
      });
    }
    return { receipt };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : "";
  };
  const canaryEvidencePath = argument("canary-evidence");
  const result = await promoteDesktopStable({
    bucket: argument("bucket"),
    version: argument("version"),
    canaryEvidencePath,
  });
  const outputPath = resolve("desktop/dist", `stable-promotion-${result.receipt.target}-${result.receipt.version}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result.receipt, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: true, receiptPath: outputPath }, null, 2));
}
