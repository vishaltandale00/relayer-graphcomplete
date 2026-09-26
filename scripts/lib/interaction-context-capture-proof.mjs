function normalizeVisibleText(value) {
  return String(value ?? "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function validateVisibleBoundaryHold({
  startFrame,
  endFrame,
  expectedText,
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
  if (missingStart.length || missingEnd.length) {
    throw new Error(`Captured boundary text did not match at both ends: ${JSON.stringify({ missingStart, missingEnd })}`);
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
