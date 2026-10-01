(() => {
  const [supplied, ...fragmentOptions] = location.hash.slice(1).split("&");
  const returnKey = "relayer-eval-return";
  function dashboardAddress(value) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port
        && !url.username && !url.password && url.pathname === "/" && !url.search
        && /^#[a-f0-9]{64}$/.test(url.hash) ? url.href : null;
    } catch { return null; }
  }
  const suppliedReturn = dashboardAddress(new URLSearchParams(fragmentOptions.join("&")).get("returnTo"));
  if (suppliedReturn) sessionStorage.setItem(returnKey, suppliedReturn);
  const returnTo = suppliedReturn || dashboardAddress(sessionStorage.getItem(returnKey));
  if (/^[a-f0-9]{64}$/.test(supplied)) {
    sessionStorage.setItem("relayer-eval-capability", supplied);
  }
  const capability = sessionStorage.getItem("relayer-eval-capability");
  // Keep the authenticated link portable across browsers. Older tabs already
  // stored their capability but removed it from the address bar; restore it.
  if (!location.hash && /^[a-f0-9]{64}$/.test(capability || "")) {
    history.replaceState(null, "", `${location.pathname}${location.search}#${capability}${returnTo ? `&${new URLSearchParams({ returnTo })}` : ""}`);
  }
  let settingsMode = false;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin !== location.origin) return nativeFetch(input, options);
    const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
    if (capability) headers.set("Authorization", `Bearer ${capability}`);
    return nativeFetch(input, { ...options, headers, credentials: "omit" }).then((response) => {
      const method = options.method || (input instanceof Request ? input.method : "GET");
      if (response.ok && settingsMode
        && ["POST", "PUT", "DELETE"].includes(method.toUpperCase())
        && /^\/api\/(?:model-families|model-settings)(?:\/|$)/.test(url.pathname)) {
        window.dispatchEvent(new Event("relayer-eval-model-settings-changed"));
      }
      return response;
    });
  };
  async function result(response) {
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
    return value;
  }
  const call = (operation, ...args) => fetch(`/eval-api/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args),
  }).then(result);
  window.initializeRelayerEvalSettings = () => {
    if (settingsMode) return;
    settingsMode = true;
    delete window.relayerEvalReview;
    delete window.relayerEval;
    delete window.relayerEvalTrace;
    const listeners = new Set();
    let definitions = [];
    const changed = () => { for (const listener of listeners) listener(); };
    const mutate = async (name, ...args) => { const value = await call(name, ...args); changed(); return value; };
    async function authenticate(name, input) {
      const adapterId = name === "connect" ? input.adapterId : definitions.find((item) => item.id === input)?.adapterId;
      const native = adapterId === "codex-subscription";
      const tab = native ? window.open("about:blank", "_blank") : null;
      if (native && !tab) throw new Error("Allow popups to sign in to this provider.");
      if (tab) tab.opener = null;
      try {
        const value = await mutate(name, input);
        if (value.login?.authUrl) {
          const url = new URL(value.login.authUrl);
          if (url.protocol !== "https:") throw new Error("Provider sign-in requires a secure URL.");
          if (tab) tab.location = url.href;
        } else tab?.close();
        return value;
      } catch (error) { tab?.close(); throw error; }
    }
    window.relayerEvalSettings = { returnTo };
    window.relayerDesktop = {
      models: { settingsOpened: () => call("settingsOpened"), refresh: (id) => mutate("refresh", id) },
      providers: {
        status: async () => { const value = await call("status"); definitions = value.definitions; return value; },
        connect: (input) => authenticate("connect", input),
        reconnect: (id) => authenticate("reconnect", id),
        ...Object.fromEntries(["completeConnection", "cancelConnection", "rename", "logout", "remove"].map((name) => [name, (...args) => mutate(name, ...args)])),
        onChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
    };
  };
  if (new URLSearchParams(location.search).get("evalSettings") === "1") {
    window.initializeRelayerEvalSettings();
    return;
  }
  function open(path, params = {}) {
    const url = new URL(path, location.origin);
    url.search = new URLSearchParams(params);
    url.hash = capability || "";
    window.open(url.href, "_blank", "noopener,noreferrer");
  }
  window.relayerEval = {
    ...Object.fromEntries(["calibrationCatalog", "freezeCalibrationSet", "compareSetupRevisions", "recordCalibrationObservation", "calibrationReport", "exportCalibration", "calibrationSource", "setupRevisions", "publishSetup", "promoteSetup", "catalog", "listRuns", "getRun", "createRun", "judgeImportedConversation", "rejudgeExecution", "exportAnnotations", "loadJudgeScreenshot", "humanTasks", "humanTask", "actorScreenshot", "createHumanTask", "nextHumanTaskStep", "finishHumanTask", "gradeHumanTask", "annotateHumanTask", "exportHumanTask", "stopTaskActor"].map((name) => [name, (...args) => call(name, ...args)])),
    async openSettings() {
      const tab = window.open("about:blank", "_blank");
      if (!tab) throw new Error("Allow popups to open Eval Settings.");
      tab.opener = null;
      try {
        const settings = new URL(await call("openSettings"));
        const dashboard = new URL("/", location.origin);
        dashboard.hash = capability || "";
        settings.hash += `&${new URLSearchParams({ returnTo: dashboard.href })}`;
        tab.location = settings.href;
      } catch (error) { tab.close(); throw error; }
    },
    async openHumanTask(id, review = false) {
      const tab = window.open("about:blank", "_blank");
      if (!tab) throw new Error("Allow popups to open the task workspace.");
      tab.opener = null;
      try { tab.location = await call(review ? "reviewHumanTask" : "openHumanTask", id); }
      catch (error) { tab.close(); throw error; }
    },
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
  const workspaceLayout = {
    read: () => fetch("/eval-api/workspace-layout").then(result),
    set: (ratio) => fetch("/eval-api/workspace-layout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ratio) }).then(result),
  };
  window.relayerEvalTrace = { load: (id, turn) => call("loadCandidateTrace", id, turn) };
  if (new URLSearchParams(location.search).get("humanTask") === "1") {
    window.relayerHumanTask = {
      workspaceLayout,
      task: () => fetch("/eval-api/task").then(result),
      grade: (input) => fetch("/eval-api/grade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }).then(result),
      finish: (input) => fetch("/eval-api/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }).then(result),
      annotate: (input) => fetch("/eval-api/annotate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }).then(result),
      context: async () => {
        const task = await fetch("/eval-api/task").then(result);
        return { selectedExecutionId: task.id, harnessConfigurationName: task.prepared.execution.harnessConfigurationName,
          cases: [{ name: task.prepared.name, status: task.status, threadIds: task.threadIds, threads: task.threadIds.map((id, index) => ({ id, name: task.prepared.plan[index]?.name || `Step ${index + 1}` })) }] };
      },
      observe: (snapshot) => {
        if (new URLSearchParams(location.search).get("taskActor") === "1") window.__taskActorPresentation = { threadId: snapshot.threadId, turnId: snapshot.turnId, layerId: snapshot.layerId, selectedNodeId: snapshot.selectedNodeId, navigationPath: snapshot.navigationPath, completionStatus: snapshot.completionStatus, attemptId: snapshot.attemptId, attemptOutcome: snapshot.attemptOutcome, observedAt: snapshot.observedAt };
        return fetch("/eval-api/observe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot) }).then(result);
      },
    };
    return;
  }
  if (new URLSearchParams(location.search).get("humanGrading") === "1") {
    window.relayerHumanGrading = {
      task: () => fetch("/eval-api/task").then(result),
      grade: (input) => fetch("/eval-api/grade", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }).then(result),
      annotate: (input) => fetch("/eval-api/annotate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }).then(result),
    };
  }
  window.relayerEvalReview = {
    workspaceLayout,
    context: () => fetch("/eval-api/context").then(result),
    registerPresentationAdapter: (adapter) => { window.__evalPresentation = adapter; },
  };
})();
