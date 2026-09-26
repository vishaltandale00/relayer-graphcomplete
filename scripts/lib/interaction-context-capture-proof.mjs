import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

function normalizeVisibleText(value) {
  return String(value ?? "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export async function captureTrackedWorkspaceSnapshot(root, excludedPaths = []) {
  const excluded = new Set(excludedPaths.map((path) => path.replaceAll("\\", "/")));
  const trackedPaths = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0").filter(Boolean).sort();
  const untrackedPaths = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  }).split("\0").filter(Boolean)
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !excluded.has(path))
    .sort();
  const digest = createHash("sha256");
  let trackedFileCount = 0;

  for (const path of trackedPaths) {
    const normalizedPath = path.replaceAll("\\", "/");
    if (excluded.has(normalizedPath)) continue;
    const absolutePath = join(root, path);
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      throw new Error(`Tracked workspace file is missing after capture: ${path}`, { cause: error });
    }
    digest.update(`${normalizedPath}\0${metadata.mode & 0o777}\0`);
    if (metadata.isSymbolicLink()) digest.update(await readlink(absolutePath));
    else if (metadata.isFile()) digest.update(await readFile(absolutePath));
    else throw new Error(`Tracked workspace entry is not a regular file or symlink: ${path}`);
    digest.update("\0");
    trackedFileCount += 1;
  }

  return {
    sha256: digest.digest("hex"),
    trackedFileCount,
    untrackedPaths,
    excludedPaths: [...excluded].sort(),
  };
}

export function assertTrackedWorkspaceUnchanged(before, after) {
  if (!before || !after
    || before.sha256 !== after.sha256
    || before.trackedFileCount !== after.trackedFileCount
    || JSON.stringify(before.untrackedPaths) !== JSON.stringify(after.untrackedPaths)) {
    throw new Error(`Tracked production workspace changed during capture: ${JSON.stringify({ before, after })}`);
  }
}

export function validateVisibleBoundaryHold({
  startFrame,
  endFrame,
  expectedText,
  expectedAbsentText = [],
  minimumHoldMs,
  maximumCaptureGapMs,
}) {
  if (!startFrame || !endFrame || !Array.isArray(expectedText) || expectedText.length === 0
    || expectedText.some((value) => !normalizeVisibleText(value))) {
    throw new Error("A visible boundary requires captured start/end frames and expected screen text.");
  }
  if (endFrame.frameNumber <= startFrame.frameNumber
    || endFrame.elapsedMs <= startFrame.elapsedMs
    || endFrame.elapsedMs - startFrame.elapsedMs < minimumHoldMs) {
    throw new Error(`The captured visible boundary hold is shorter than ${minimumHoldMs}ms.`);
  }
  if (!Number.isFinite(endFrame.maximumCaptureGapMs)
    || endFrame.maximumCaptureGapMs > maximumCaptureGapMs) {
    throw new Error(`The visible boundary hold has a ${endFrame.maximumCaptureGapMs}ms capture gap.`);
  }
  const normalizedStart = normalizeVisibleText(startFrame.recognizedText);
  const normalizedEnd = normalizeVisibleText(endFrame.recognizedText);
  const missingStart = expectedText.filter((needle) => !normalizedStart.includes(normalizeVisibleText(needle)));
  const missingEnd = expectedText.filter((needle) => !normalizedEnd.includes(normalizeVisibleText(needle)));
  const unexpectedStart = expectedAbsentText.filter((needle) => normalizedStart.includes(normalizeVisibleText(needle)));
  const unexpectedEnd = expectedAbsentText.filter((needle) => normalizedEnd.includes(normalizeVisibleText(needle)));
  if (missingStart.length || missingEnd.length || unexpectedStart.length || unexpectedEnd.length) {
    throw new Error(`Captured boundary text did not match at both ends: ${JSON.stringify({
      missingStart,
      missingEnd,
      unexpectedStart,
      unexpectedEnd,
    })}`);
  }
  return endFrame.elapsedMs - startFrame.elapsedMs;
}

export function validateTerminalFrameCoverage({
  capturedPresentationMs,
  encodedPresentationMs,
  containerDurationMs,
  terminalFrameHoldMs,
  timingToleranceMs = 5,
}) {
  if (!Array.isArray(capturedPresentationMs) || capturedPresentationMs.length < 2
    || capturedPresentationMs.some((timestamp) => !Number.isFinite(timestamp))
    || !Array.isArray(encodedPresentationMs)
    || encodedPresentationMs.length !== capturedPresentationMs.length + 2
    || encodedPresentationMs.some((timestamp) => !Number.isFinite(timestamp))) {
    throw new Error("The VFR stream must contain every captured frame plus two explicit terminal-hold frames.");
  }
  const mismatchedCapturedFrames = capturedPresentationMs.flatMap((timestamp, index) => (
    Math.abs(encodedPresentationMs[index] - timestamp) > timingToleranceMs ? [index] : []
  ));
  if (mismatchedCapturedFrames.length) {
    throw new Error(`VFR timestamps do not match captured frames: ${mismatchedCapturedFrames.join(", ")}`);
  }
  const firstTerminalHoldMs = capturedPresentationMs.at(-1) + terminalFrameHoldMs;
  const expectedTerminalPresentationMs = firstTerminalHoldMs + terminalFrameHoldMs;
  if (Math.abs(encodedPresentationMs.at(-2) - firstTerminalHoldMs) > timingToleranceMs
    || Math.abs(encodedPresentationMs.at(-1) - expectedTerminalPresentationMs) > timingToleranceMs) {
    throw new Error("Repeated terminal frames do not span the two declared final-frame holds.");
  }
  const requiredContainerDurationMs = encodedPresentationMs.at(-1) + 1;
  if (!Number.isFinite(containerDurationMs) || containerDurationMs < requiredContainerDurationMs) {
    throw new Error(`The container ends before its terminal frame: ${JSON.stringify({
      containerDurationMs,
      requiredContainerDurationMs,
    })}`);
  }
  return {
    terminalFrameHoldMs,
    repeatedTerminalHoldCount: 2,
    terminalFramePresentationMs: encodedPresentationMs.at(-1),
    requiredContainerDurationMs,
  };
}
