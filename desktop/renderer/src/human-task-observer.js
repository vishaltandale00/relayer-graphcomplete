// Only installed for an explicit Eval live-task capability. No product behavior
// depends on this observer, and it never supplies feedback to the acting user.
export function observeHumanTaskPresentation({ bridge, getState, documentObject = document, windowObject = window }) {
  let stopped = false;
  let scheduled = false;
  let previous;
  let captureFailures = 0;
  let retry;
  let pending = Promise.resolve();
  const capture = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    windowObject.requestAnimationFrame(() => windowObject.requestAnimationFrame(() => {
      scheduled = false;
      if (stopped || documentObject.visibilityState === "hidden") return;
      const graph = documentObject.querySelector("#graphStage");
      const graphVisible = Boolean(graph && !graph.classList.contains("hidden") && graph.getBoundingClientRect().width > 0);
      const snapshot = { ...getState(), graphVisible, captureFailures,
        content: ["#threadTitle", "#graphStage", "#inspectorContent", "#readOnlyComposerMessage"].map((selector) => {
          const element = documentObject.querySelector(selector);
          return element && element.getBoundingClientRect().width > 0 ? element.innerText : "";
        }).join("\n").slice(0, 200000),
      };
      const key = JSON.stringify(snapshot);
      if (key === previous) return;
      previous = key;
      snapshot.observedAt = Date.now();
      // Local after-paint state must not lag behind a queued evidence write.
      bridge.present?.(snapshot);
      pending = pending.then(() => bridge.observe(snapshot)).catch(() => {
        // Evidence gaps are visible on review; never block the human's task.
        captureFailures++;
        previous = undefined;
        clearTimeout(retry);
        retry = setTimeout(capture, 1000);
      });
    }));
  };
  const observer = new windowObject.MutationObserver(capture);
  observer.observe(documentObject.querySelector(".workspace-layout") || documentObject.body, { subtree: true, childList: true, attributes: true, characterData: true });
  documentObject.addEventListener("visibilitychange", capture);
  const stop = () => { stopped = true; clearTimeout(retry); observer.disconnect(); documentObject.removeEventListener("visibilitychange", capture); };
  windowObject.addEventListener("pagehide", stop, { once: true });
  capture();
  return stop;
}
