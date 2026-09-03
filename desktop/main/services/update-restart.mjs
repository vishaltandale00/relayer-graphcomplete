/**
 * Restarting for an update stops the running threads and then relaunches.
 *
 * The stopping half is already bounded: the graph runtime signals its work to
 * stop and terminates its children under its own deadline, as does the app
 * server. What follows is bookkeeping, and it must never hold the restart open.
 * The install only runs once this settles, so a service that never closes would
 * otherwise strand the user on a verified update with no feedback.
 */
export async function settleShutdownWithin({
  shutdown,
  budgetMs,
  onTimeout = () => {},
  onError = () => {},
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof shutdown !== "function") throw new TypeError("A shutdown function is required.");
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new TypeError("A positive shutdown budget is required.");
  let timer;
  let timedOut = false;
  const budget = new Promise((resolve) => {
    timer = setTimeoutImpl(() => {
      timedOut = true;
      onTimeout(budgetMs);
      resolve();
    }, budgetMs);
  });
  try {
    await Promise.race([
      Promise.resolve()
        .then(shutdown)
        .catch((error) => { onError(error); }),
      budget,
    ]);
  } finally {
    clearTimeoutImpl(timer);
  }
  return { timedOut };
}
