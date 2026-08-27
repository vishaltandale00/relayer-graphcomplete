function childShutdownDeadlineError() {
  const error = new Error("Child process did not stop before shutdown deadline.");
  error.code = "RELAYER_CHILD_SHUTDOWN_TIMEOUT";
  return error;
}

export async function terminateChildProcess(child, { gracePeriodMs = 2_000, deadlineMs } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const boundedByDeadline = Number.isFinite(deadlineMs);
  const remainingMs = boundedByDeadline ? Math.max(0, deadlineMs - Date.now()) : gracePeriodMs * 2;
  if (remainingMs === 0) {
    child.kill("SIGKILL");
    if (child.exitCode !== null || child.signalCode !== null) return;
    throw childShutdownDeadlineError();
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    let forceTimer;
    let failureTimer;
    const cleanup = () => {
      clearTimeout(forceTimer);
      clearTimeout(failureTimer);
      child.off("exit", onStopped);
      child.off("close", onStopped);
    };
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const onStopped = () => finish(resolve);
    child.once("exit", onStopped);
    child.once("close", onStopped);
    const forceAfterMs = boundedByDeadline
      ? Math.min(gracePeriodMs, Math.floor(remainingMs / 2))
      : gracePeriodMs;
    const force = () => {
      if (child.exitCode !== null || child.signalCode !== null) return onStopped();
      try {
        child.kill("SIGKILL");
      } catch (error) {
        finish(() => reject(error));
      }
    };
    forceTimer = setTimeout(force, forceAfterMs);
    failureTimer = setTimeout(() => {
      force();
      finish(() => reject(boundedByDeadline
        ? childShutdownDeadlineError()
        : new Error("Child process did not stop after SIGKILL.")));
    }, remainingMs);
    try {
      child.kill("SIGTERM");
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
