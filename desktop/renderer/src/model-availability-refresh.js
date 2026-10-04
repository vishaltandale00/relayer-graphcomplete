// Start after the workspace initializes. Subscribe before the catch-up read so
// commits made before a window/listener existed, or during that read, are covered.
export function watchModelAvailability({ subscribe, refresh, onError }) {
  let pending = false;
  let running = null;
  let stopped = false;
  function requestRefresh() {
    if (stopped) return Promise.resolve();
    pending = true;
    running ??= Promise.resolve().then(async () => {
      while (pending && !stopped) {
        pending = false;
        try {
          await refresh();
        } catch (error) {
          onError(error);
        }
      }
    }).finally(() => {
      running = null;
      // A notification may arrive after the loop ends but before this promise settles.
      if (pending && !stopped) void requestRefresh();
    });
    return running;
  }
  const unsubscribe = subscribe(() => { void requestRefresh(); });
  return Object.freeze({
    ready: requestRefresh(),
    stop() {
      if (stopped) return;
      stopped = true;
      pending = false;
      unsubscribe();
    },
  });
}
