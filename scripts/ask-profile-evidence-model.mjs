export function isFreshRecordedPromptFrame(frame, promptValidatedAt) {
  return Number.isFinite(promptValidatedAt)
    && Number.isFinite(frame?.captureStartedAt)
    && Number.isFinite(frame?.captureCompletedAt)
    && frame.captureStartedAt >= promptValidatedAt
    && frame.captureCompletedAt >= frame.captureStartedAt
    && Number.isInteger(frame?.frameIndex)
    && frame.frameIndex >= 0;
}

const VIDEO_OFFSET_TOLERANCE_MS = 0.001;

export function validateApprovalPromptHoldEvidence({
  screenshots,
  holds,
  requiredDurationMs,
  minimumFrames,
  encodedDurationMs,
  frameIntervalMs,
}) {
  const waitingScreenshots = Object.entries(screenshots)
    .filter(([, screenshot]) => screenshot.approvalRequestId != null);
  if (waitingScreenshots.length !== 7 || holds.length !== waitingScreenshots.length) {
    throw new Error(`Approval prompt evidence must contain exactly seven waiting captures and holds: ${JSON.stringify({
      waitingCaptures: waitingScreenshots.length,
      holds: holds.length,
    })}`);
  }
  const labels = new Set();
  const requestIds = new Set();
  let previousHold;
  for (const hold of holds) {
    if (labels.has(hold.label) || requestIds.has(hold.requestId)) {
      throw new Error(`Approval prompt evidence contains a duplicate hold: ${JSON.stringify(hold)}`);
    }
    labels.add(hold.label);
    requestIds.add(hold.requestId);
    const screenshot = screenshots[hold.label];
    const frameDelta = hold.frameCountAtEnd - hold.frameCountAtStart;
    const videoSpanMs = hold.videoEndOffsetMs - hold.videoStartOffsetMs;
    const expectedVideoStartOffsetMs = hold.frameCountAtStart * frameIntervalMs;
    const expectedVideoEndOffsetMs = hold.frameCountAtEnd * frameIntervalMs;
    const numericFields = [
      hold.requiredMs,
      hold.observedMs,
      hold.stableStateSamples,
      hold.videoStartOffsetMs,
      hold.videoEndOffsetMs,
      hold.frameCountAtStart,
      hold.frameCountAtEnd,
    ];
    if (screenshot?.approvalRequestId !== hold.requestId
      || numericFields.some((value) => !Number.isFinite(value) || value < 0)
      || !Number.isInteger(hold.requiredMs)
      || !Number.isInteger(hold.stableStateSamples)
      || !Number.isInteger(hold.frameCountAtStart)
      || !Number.isInteger(hold.frameCountAtEnd)
      || hold.requiredMs !== requiredDurationMs
      || hold.observedMs < requiredDurationMs
      || frameDelta < minimumFrames
      || hold.stableStateSamples < 2
      || hold.videoEndOffsetMs <= hold.videoStartOffsetMs
      || videoSpanMs < requiredDurationMs
      || Math.abs(videoSpanMs - (frameDelta * frameIntervalMs)) > VIDEO_OFFSET_TOLERANCE_MS
      || Math.abs(hold.videoStartOffsetMs - expectedVideoStartOffsetMs) > VIDEO_OFFSET_TOLERANCE_MS
      || Math.abs(hold.videoEndOffsetMs - expectedVideoEndOffsetMs) > VIDEO_OFFSET_TOLERANCE_MS
      || hold.videoEndOffsetMs > encodedDurationMs + frameIntervalMs) {
      throw new Error(`Approval prompt hold does not prove a stable recorded interval: ${JSON.stringify({ hold, frameDelta, videoSpanMs })}`);
    }
    if (previousHold && (hold.frameCountAtStart < previousHold.frameCountAtEnd
      || hold.videoStartOffsetMs < previousHold.videoEndOffsetMs)) {
      throw new Error(`Approval prompt hold intervals must be ordered and non-overlapping: ${JSON.stringify({
        previous: previousHold,
        current: hold,
      })}`);
    }
    previousHold = hold;
  }
  for (const [label, screenshot] of waitingScreenshots) {
    if (!holds.some((hold) => hold.label === label && hold.requestId === screenshot.approvalRequestId)) {
      throw new Error(`Waiting capture is missing a correlated approval prompt hold: ${label}`);
    }
  }
  return true;
}
