import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export async function loadJudgeScreenshotArtifact({ stateFile, executionId, judgeResultId, screenshotId }) {
  requireIdentifier(executionId, "execution");
  requireIdentifier(judgeResultId, "judge result");
  requireIdentifier(screenshotId, "screenshot");

  const state = JSON.parse(await readFile(stateFile, "utf8"));
  const matches = [];
  for (const run of state?.runs || []) {
    for (const execution of run?.executions || []) {
      if (String(execution?.id) === executionId) matches.push({ run, execution });
    }
  }
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous Eval execution: ${executionId}`);

  const { run, execution } = matches[0];
  const judgeResults = (execution.turns || []).flatMap((turn) => turn.judgeResults || []);
  const resultMatches = judgeResults.filter((result) => String(result?.id) === judgeResultId);
  if (resultMatches.length !== 1) {
    throw new Error(`Unknown or ambiguous judge result for execution ${executionId}: ${judgeResultId}`);
  }
  const judgeResult = resultMatches[0];
  const reference = declaredScreenshotReference(judgeResult, screenshotId);

  const evalDataRoot = dirname(resolve(stateFile));
  const runRoot = resolve(evalDataRoot, "runs", encodeURIComponent(String(run.id)));
  const artifactDirectory = resolve(String(judgeResult.artifactDirectory || ""));
  await assertContainedRealPath(evalDataRoot, runRoot, "Eval run root");
  await assertContainedRealPath(runRoot, artifactDirectory, "Judge artifact directory");

  const metadataPath = resolve(artifactDirectory, ...reference.split("/"));
  await assertContainedRealPath(runRoot, metadataPath, "Screenshot metadata");
  if (basename(metadataPath) !== "metadata.json") throw new Error("Screenshot metadata reference is invalid.");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  validateMetadata(metadata, { executionId, screenshotId });

  const screenshotDirectory = dirname(metadataPath);
  const tiles = await Promise.all([...metadata.tiles]
    .sort((left, right) => left.index - right.index)
    .map(async (tile) => {
      const filename = `${screenshotId}-${String(tile.index + 1).padStart(3, "0")}.png`;
      const tilePath = resolve(screenshotDirectory, filename);
      await assertContainedRealPath(runRoot, tilePath, "Screenshot tile");
      const bytes = await readFile(tilePath);
      if (bytes.length < pngSignature.length || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
        throw new Error(`Screenshot tile is not a PNG: ${filename}`);
      }
      const contentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (contentDigest !== tile.contentDigest) {
        throw new Error(`Screenshot tile digest does not match immutable metadata: ${filename}`);
      }
      return {
        index: tile.index,
        width: tile.width,
        height: tile.height,
        contentDigest: tile.contentDigest,
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      };
    }));
  if (tiles.length !== metadata.tileCount) throw new Error("Screenshot tile count does not match metadata.");
  return { screenshotId, metadata: structuredClone(metadata), tiles };
}

function declaredScreenshotReference(judgeResult, screenshotId) {
  const expected = `screenshots/${screenshotId}/metadata.json`;
  const references = judgeResult?.references?.screenshots;
  if (!Array.isArray(references) || !references.includes(expected)) {
    throw new Error(`Screenshot is not declared by judge result ${judgeResult.id}: ${screenshotId}`);
  }
  return expected;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string" || !value.length || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error(`Invalid ${label} identifier.`);
  }
}

function validateMetadata(metadata, { executionId, screenshotId }) {
  if (!metadata || metadata.screenshotId !== screenshotId || String(metadata.executionId) !== executionId) {
    throw new Error("Screenshot metadata does not match the requested execution and screenshot.");
  }
  if (!Number.isInteger(metadata.tileCount) || metadata.tileCount < 1 || !Array.isArray(metadata.tiles)) {
    throw new Error("Screenshot metadata has no valid tiles.");
  }
  const indices = metadata.tiles.map((tile) => tile?.index);
  if (indices.some((index) => !Number.isInteger(index) || index < 0) || new Set(indices).size !== indices.length) {
    throw new Error("Screenshot metadata has invalid tile indices.");
  }
  if (indices.some((index, offset) => [...indices].sort((left, right) => left - right)[offset] !== offset)) {
    throw new Error("Screenshot metadata tile indices are not contiguous.");
  }
  if (metadata.tiles.some((tile) => !/^sha256:[0-9a-f]{64}$/.test(tile?.contentDigest))) {
    throw new Error("Screenshot metadata has an invalid tile digest.");
  }
}

async function assertContainedRealPath(root, target, label) {
  if (!isAbsolute(root) || !isAbsolute(target) || !isPathInside(root, target)) {
    throw new Error(`${label} escapes its authorized root.`);
  }
  await assertNoSymlinks(root, target, label);
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
  if (!isPathInside(realRoot, realTarget)) throw new Error(`${label} resolves outside its authorized root.`);
}

async function assertNoSymlinks(root, target, label) {
  if ((await lstat(root)).isSymbolicLink()) throw new Error(`${label} must not use symbolic links.`);
  const pathFromRoot = relative(root, target);
  let candidate = root;
  for (const part of pathFromRoot.split(sep).filter(Boolean)) {
    candidate = join(candidate, part);
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error(`${label} must not use symbolic links.`);
  }
}

function isPathInside(root, target) {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}
