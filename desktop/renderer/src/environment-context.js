export const ENVIRONMENT_REFRESH_INTERVAL_MS = 5_000;
export const ENVIRONMENT_MAX_BACKOFF_MS = 60_000;
export const ENVIRONMENT_STACK_BREAKPOINT_PX = 1_100;

export function desktopRailGeometry(viewportWidth) {
  const stacked = viewportWidth <= ENVIRONMENT_STACK_BREAKPOINT_PX;
  const sidebarWidth = viewportWidth <= 760 ? 0 : viewportWidth <= 980 ? 210 : 244;
  const rightInset = 12;
  const gutter = 12;
  const railWidth = stacked ? null : 340;
  return {
    stacked,
    sidebarWidth,
    rightInset,
    gutter,
    railWidth,
    leftColumnWidth: stacked
      ? viewportWidth - sidebarWidth - rightInset * 2
      : viewportWidth - sidebarWidth - rightInset - gutter - railWidth,
  };
}

export function environmentRefreshNeeded({
  currentProjectId,
  requestedProjectId,
  lastRequestedAt,
  now,
  force = false,
  minimumAgeMs = 0,
  nextAttemptAt = 0,
}) {
  if (requestedProjectId == null) return false;
  return (force && now >= nextAttemptAt && now - lastRequestedAt >= minimumAgeMs)
    || String(currentProjectId) !== String(requestedProjectId)
    || (
      now >= nextAttemptAt
      && now - lastRequestedAt >= ENVIRONMENT_REFRESH_INTERVAL_MS
    );
}

export function environmentRefreshDelay({
  lastRequestedAt,
  nextAttemptAt = 0,
  now,
}) {
  return Math.max(
    0,
    Math.max(lastRequestedAt + ENVIRONMENT_REFRESH_INTERVAL_MS, nextAttemptAt) - now,
  );
}

export function createEnvironmentRefreshScheduler({
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let timer = null;
  return Object.freeze({
    schedule({ eligible, projectId, lastRequestedAt, nextAttemptAt, now, refresh }) {
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (!eligible || projectId == null) return false;
      const delayMs = environmentRefreshDelay({ lastRequestedAt, nextAttemptAt, now });
      timer = setTimer(() => {
        timer = null;
        refresh(projectId);
      }, delayMs);
      return delayMs;
    },
    clear() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  });
}

const DURABLE_UNAVAILABLE_REASONS = new Set(["path_unavailable", "path_retargeted"]);

export function resolveEnvironmentSnapshot(snapshot, previousSnapshot = null) {
  const unavailableCode = snapshot?.kind === "unavailable"
    ? snapshot.unavailableReason?.code
    : null;
  if (snapshot?.kind !== "unavailable" || DURABLE_UNAVAILABLE_REASONS.has(unavailableCode)) {
    return {
      status: "ready",
      snapshot,
      error: null,
      retryable: false,
    };
  }
  return {
    status: "error",
    snapshot: previousSnapshot ?? snapshot,
    error: snapshot?.unavailableReason?.message || "Project context is temporarily unavailable.",
    retryable: true,
  };
}

export function environmentBackoffAfterFailure(failureCount, now) {
  const nextFailureCount = Math.max(0, failureCount) + 1;
  const delayMs = Math.min(
    ENVIRONMENT_REFRESH_INTERVAL_MS * (2 ** (nextFailureCount - 1)),
    ENVIRONMENT_MAX_BACKOFF_MS,
  );
  return { failureCount: nextFailureCount, nextAttemptAt: now + delayMs, delayMs };
}

export function latestInteractionForThread(interactions, threadId) {
  return (interactions || []).reduce((latest, interaction) => {
    if (String(interaction.threadId) !== String(threadId)) return latest;
    if (!latest) return interaction;
    const latestSequence = Number(latest.sequence);
    const candidateSequence = Number(interaction.sequence);
    if (Number.isFinite(latestSequence) && Number.isFinite(candidateSequence)) {
      return candidateSequence >= latestSequence ? interaction : latest;
    }
    return interaction;
  }, null);
}

const PENDING_STATUSES = new Set([
  "not_started",
  "running",
  "submitted",
  "waiting_for_approval",
]);

export function interactionReachedTerminal(previous, next) {
  return previous?.id != null
    && String(previous.id) === String(next?.id)
    && PENDING_STATUSES.has(previous.completionStatus)
    && !PENDING_STATUSES.has(next?.completionStatus);
}

export function createPostFlightRefreshQueue() {
  let queuedProjectId = null;
  return Object.freeze({
    queue(projectId, force) {
      if (force) queuedProjectId = String(projectId);
    },
    discardExcept(projectId) {
      if (queuedProjectId !== null && queuedProjectId !== String(projectId)) queuedProjectId = null;
    },
    consume(completedProjectId, activeProjectId, workspaceActive) {
      const shouldRun = workspaceActive
        && queuedProjectId === String(completedProjectId)
        && queuedProjectId === String(activeProjectId);
      if (queuedProjectId === String(completedProjectId)) queuedProjectId = null;
      return shouldRun;
    },
    clear() {
      queuedProjectId = null;
    },
  });
}
