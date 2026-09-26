(() => {
  const supplied = location.hash.slice(1);
  if (/^[a-f0-9]{64}$/.test(supplied)) {
    sessionStorage.setItem("relayer-eval-capability", supplied);
    history.replaceState(null, "", location.pathname + location.search);
  }
  const capability = sessionStorage.getItem("relayer-eval-capability");
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin !== location.origin) return nativeFetch(input, options);
    const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
    if (capability) headers.set("Authorization", `Bearer ${capability}`);
    return nativeFetch(input, { ...options, headers, credentials: "omit" });
  };
  async function result(response) {
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
    return value;
  }
  const call = (operation, ...args) => fetch(`/eval-api/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args),
  }).then(result);
  function open(path, params = {}) {
    const url = new URL(path, location.origin);
    url.search = new URLSearchParams(params);
    url.hash = capability || "";
    window.open(url.href, "_blank", "noopener,noreferrer");
  }
  window.relayerEval = {
    ...Object.fromEntries(["catalog", "listRuns", "getRun", "createRun", "judgeImportedConversation", "rejudgeExecution", "exportAnnotations", "loadJudgeScreenshot"].map((name) => [name, (...args) => call(name, ...args)])),
    async openReview(id) {
      // Open synchronously so a slow backend does not trigger popup blocking.
      const tab = window.open("about:blank", "_blank");
      if (!tab) throw new Error("Allow popups to open the product workspace.");
      tab.opener = null;
      try { tab.location = await call("openReview", id); } catch (error) { tab.close(); throw error; }
    },
    openJudgeReview: async (id) => {
      // The viewer resolves its run from the execution if no runId is supplied.
      open("/judge.html", { executionId: id });
    },
    openCandidateTrace: async (id, interactionId) => open("/trace.html", { executionId: id, ...(interactionId ? { interactionId } : {}) }),
    importConversation: () => new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file"; input.accept = ".jsonl";
      input.oncancel = () => resolve(null);
      input.onchange = async () => {
        if (!input.files[0]) return resolve(null);
        try { resolve(await result(await fetch("/eval-api/import", { method: "POST", body: input.files[0] }))); }
        catch (error) { reject(error); }
      };
      input.click();
    }),
    onRunsChanged(callback) {
      let stopped = false;
      let timer;
      const poll = async () => {
        try { const runs = await call("listRuns"); if (!stopped) callback(runs); }
        catch { /* A stopped host is reported by the next explicit operation. */ }
        finally { if (!stopped) timer = setTimeout(poll, 1000); }
      };
      timer = setTimeout(poll, 1000);
      return () => { stopped = true; clearTimeout(timer); };
    },
  };
  window.relayerEvalTrace = { load: (id, turn) => call("loadCandidateTrace", id, turn) };
  window.relayerEvalReview = {
    context: () => fetch("/eval-api/context").then(result),
    registerPresentationAdapter: (adapter) => { window.__evalPresentation = adapter; },
  };
})();
