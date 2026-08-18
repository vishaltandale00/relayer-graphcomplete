export async function terminateChildProcess(child, { gracePeriodMs = 2_000 } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
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
    forceTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return onStopped();
      try {
        child.kill("SIGKILL");
      } catch (error) {
        finish(() => reject(error));
      }
    }, gracePeriodMs);
    failureTimer = setTimeout(() => {
      finish(() => reject(new Error("Child process did not stop after SIGKILL.")));
    }, gracePeriodMs * 2);
    try {
      child.kill("SIGTERM");
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
