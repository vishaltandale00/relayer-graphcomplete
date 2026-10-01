const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function initializeHumanTasks({ api, show, toast }) {
  const root = document.querySelector("#humanView");
  let selected;
  let displayedStatus;
  let checkingStatus = false;
  const run = async (action) => { try { await action(); } catch (error) { toast(error.message); } };
  const download = (bundle, name) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  async function list() {
    const sessions = await api.humanTasks();
    root.querySelector("#humanSessions").innerHTML = sessions.map((item) => `<button class="secondary" data-human-session="${escape(item.id)}">${escape(item.name || item.id)} · ${escape(item.mode || "human")} · ${escape(item.status)} · ${item.completions}/${item.maxCompletions}</button>`).join("") || "No human sessions yet.";
    root.querySelectorAll("[data-human-session]").forEach((button) => { button.onclick = () => run(() => inspect(button.dataset.humanSession)); });
  }
  async function inspect(id, onlyStatusChange = false) {
    selected = id;
    const task = await api.humanTask(id);
    if (selected !== id || (onlyStatusChange && task.status === displayedStatus)) return;
    displayedStatus = task.status;
    const reviewable = ["completed", "failed", "interrupted"].includes(task.status);
    const active = task.status === "active";
    const simulated = task.mode === "simulated";
    const actorRating = task.events.findLast((event) => event.kind === "actor_satisfaction");
    const plan = task.prepared?.plan || [];
    root.querySelector("#humanTaskDetail").innerHTML = `
      <h2>${escape(task.prepared?.name || task.id)}</h2><p>${escape(task.status)} · ${task.completions}/${task.maxCompletions} completions · Step ${task.step + 1}/${plan.length}</p>
      ${simulated ? `<p>Simulated user · ${escape(task.actor.model)} · ${escape(task.actor.modelReasoningEffort)} reasoning · exploration ${escape(task.actor.exploration)} · meticulousness ${escape(task.actor.meticulousness)}</p>` : ""}
      ${simulated ? `<p>Actor satisfaction: ${escape(actorRating?.value ?? "not recorded")} / 4 · ${escape(actorRating?.comment || "")}</p><p>Actor-reported endpoint: ${escape(actorRating?.endpointStatus || "not assessed")}. Remaining work: ${escape(actorRating?.remainingWork || "not recorded")}</p>` : ""}
      <p><b>Endpoint:</b> ${escape(task.endpoint)}</p>
      <p>Objective success is assessed separately from human or actor satisfaction. ${task.firstVisibleGraph ? `First visible graph: ${Math.round(task.firstVisibleGraph.latencyMs)} ms (includes time before the workspace was opened).` : "First visible graph: not observed."}</p>
      ${task.prepared?.humanBrief ? `<details><summary>Private user brief · not sent to Relayer</summary><p style="white-space:pre-wrap">${escape(task.prepared.humanBrief)}</p><h3>What to grade</h3><p>${escape(task.prepared.humanRubric)}</p></details>` : ""}
      <details><summary>Case instructions</summary>${plan.map((step) => `<h3>${escape(step.name)}</h3>${step.prompts.map((text) => `<p>${escape(text)}</p>`).join("")}`).join("")}</details>
      <p id="humanLifecycle">${active && simulated ? "The simulated user is working. Open graph review to watch and grade; your feedback stays separate from its decisions." : active ? "Review and grade inside the task workspace while you interact. Save grade keeps the task active. Finish task ends interaction separately." : reviewable ? "This session has ended. Open graph review to revisit the graph and add annotations; task interaction is closed." : "The session is changing state. Graph review becomes available once it has ended."}</p>
      <div class="actions"><button id="humanOpen" class="primary" ${task.threadIds.length && (active || reviewable) ? "" : "disabled"}>${active && !simulated ? "Open task workspace" : "Open graph review"} ↗</button>
      ${active && !simulated && task.step + 1 < plan.length ? '<button id="humanNext" class="secondary">Finish step and start next</button>' : ""}
      ${["completed", "failed", "interrupted"].includes(task.status) ? '<button id="humanExport" class="secondary">Export session ↓</button>' : ""}${active && simulated ? '<button id="actorStop" class="secondary">Stop simulated user</button>' : ""}<button id="humanRefresh" class="secondary">Refresh</button></div>
      ${active && !simulated ? `<form id="humanFinish"><label>Finish reason <select name="reason"><option value="endpoint_reached">Endpoint reached</option><option value="satisfied">Satisfied</option><option value="abandoned">Abandoned</option><option value="budget_exhausted">Completion limit reached</option></select></label>
      <label>Satisfaction <select name="satisfaction"><option value="">Choose…</option><option value="1">1 · Bad</option><option value="2">2 · Needs work</option><option value="3">3 · Good</option><option value="4">4 · Great</option></select></label>
      <label>Feedback <textarea name="comment" maxlength="8000"></textarea></label><button type="button" id="humanSaveGrade" class="secondary">Save grade</button><button class="primary">Finish task</button></form>` : `<p>Termination: ${escape(task.termination?.reason || task.status)} · Satisfaction: ${escape(task.satisfaction?.value ?? "not recorded")}</p>`}
      <h3>Response timing</h3><pre>${escape(JSON.stringify(task.responseTimings || [], null, 2))}</pre><p>Only observations armed before a submission are suitable for response comparisons.</p><h3>Recorded trajectory</h3><p>Presentation records contain rendered text and navigation state, not a visual-quality verdict. Actor observations include captured screenshots.</p>
      <ol class="human-timeline">${task.events.map((event) => `<li><details ${event.observation?.screenshotArtifact ? `data-actor-image="${escape(event.id)}"` : ""}><summary>${event.sequence}. ${escape(event.kind)} · ${escape(event.at)}</summary><pre>${escape(JSON.stringify(event.observation?.screenshot ? { ...event, observation: { ...event.observation, screenshot: "PNG captured with this observation" } } : event, null, 2))}</pre>${event.observation?.screenshot ? `<img alt="Workspace observed by the simulated user" style="max-width:100%" src="data:image/png;base64,${escape(event.observation.screenshot)}">` : ""}</details>
      ${active || reviewable ? `<button class="secondary" data-annotate-event="${escape(event.id)}">Annotate this moment</button>` : ""}</li>`).join("")}</ol>
      <h3>Moment annotations</h3>${task.annotations.map((note) => `<p><b>${escape(note.eventId)}</b> ${escape(note.comment)}</p>`).join("")}
      <form id="humanAnnotation" class="hidden"><input name="eventId" type="hidden"><label>Comment on this moment<textarea name="comment" maxlength="8000" required></textarea></label><button class="primary">Save annotation</button></form>`;
    root.querySelector("#humanOpen").onclick = () => run(() => api.openHumanTask(id, !active || simulated));
    root.querySelector("#humanRefresh").onclick = () => run(() => inspect(id));
    root.querySelectorAll("[data-actor-image]").forEach(details => {
      details.ontoggle = () => {
        if (!details.open || details.dataset.loaded) return;
        details.dataset.loaded = "pending";
        void run(async () => {
          try {
            const image = document.createElement("img"); image.alt = "Workspace observed by the simulated user"; image.style.maxWidth = "100%";
            image.src = await api.actorScreenshot(id, details.dataset.actorImage); details.append(image); details.dataset.loaded = "yes";
          } catch (error) { delete details.dataset.loaded; throw error; }
        });
      };
    });
    const stopActor = root.querySelector("#actorStop");
    if (stopActor) stopActor.onclick = () => run(async () => { await api.stopTaskActor(id); await inspect(id); await list(); });
    const next = root.querySelector("#humanNext");
    if (next) next.onclick = () => run(async () => { next.disabled = true; try { await api.nextHumanTaskStep(id); await inspect(id); await list(); } finally { next.disabled = false; } });
    const exportButton = root.querySelector("#humanExport");
    if (exportButton) exportButton.onclick = () => run(async () => { const exported = await api.exportHumanTask(id); download(exported.bundle, `${id}.json`); });
    const finish = root.querySelector("#humanFinish");
    const saveGrade = root.querySelector("#humanSaveGrade");
    if (saveGrade) saveGrade.onclick = () => run(async () => {
      const data = Object.fromEntries(new FormData(finish));
      await api.gradeHumanTask(id, { satisfaction: Number(data.satisfaction), comment: data.comment });
      toast("Grade saved. The task is still active.");
    });
    if (finish) finish.onsubmit = (event) => { event.preventDefault(); void run(async () => {
      const data = Object.fromEntries(new FormData(finish)); data.satisfaction = Number(data.satisfaction);
      await api.finishHumanTask(id, { reason: data.reason }); await inspect(id); await list();
    }); };
    root.querySelectorAll("[data-annotate-event]").forEach((button) => { button.onclick = () => {
      const form = root.querySelector("#humanAnnotation"); form.classList.remove("hidden"); form.elements.eventId.value = button.dataset.annotateEvent; form.elements.comment.focus();
    }; });
    root.querySelector("#humanAnnotation").onsubmit = (event) => { event.preventDefault(); void run(async () => { await api.annotateHumanTask(id, Object.fromEntries(new FormData(event.target))); await inspect(id); }); };
  }
  async function open() {
    show("humanView");
    const catalog = await api.catalog();
    const externalIds = new Set(catalog.externalCaseIds || []);
    root.querySelector("#humanCase").innerHTML = catalog.cases.map((item) => `<option value="${escape(item.id)}" ${externalIds.has(item.id) ? "disabled" : ""}>${escape(item.name)}${externalIds.has(item.id) ? " · requires external budget/credential approval" : ""}</option>`).join("");
    root.querySelector("#humanHarness").innerHTML = catalog.harnessConfigurations.filter((item) => item.available).map((item) => `<option value="${escape(item.name)}">${escape(item.name)}</option>`).join("");
    const setEndpoint = () => { root.querySelector("#humanEndpoint").value = catalog.cases.find((item) => item.id === root.querySelector("#humanCase").value)?.description || ""; };
    root.querySelector("#humanCase").onchange = setEndpoint; setEndpoint();
    await list();
    if (selected) await inspect(selected);
  }
  // Refresh lifecycle only, so polling never overwrites an in-progress grade.
  async function refreshLifecycle() {
    if (!selected || checkingStatus || root.classList.contains("hidden")) return;
    checkingStatus = true;
    const id = selected;
    try {
      const task = await api.humanTask(id);
      if (selected === id && task.status !== displayedStatus) {
        await inspect(id, true);
        await list();
      }
    } catch { /* Explicit Refresh reports transport errors without repeated toasts. */ }
    finally { checkingStatus = false; }
  }
  const lifecycleTimer = setInterval(refreshLifecycle, 2000);
  window.addEventListener("focus", refreshLifecycle);
  window.addEventListener("pagehide", () => {
    clearInterval(lifecycleTimer);
    window.removeEventListener("focus", refreshLifecycle);
  }, { once: true });
  document.querySelector("#humanGrader").onclick = () => run(open);
  root.querySelector("#taskMode").onchange = (event) => root.querySelector("#actorSettings").classList.toggle("hidden", event.target.value !== "simulated");
  root.querySelector("#humanCreate").onsubmit = (event) => { event.preventDefault(); void run(async () => {
    const form = event.target; const button = form.querySelector("button"); button.disabled = true;
    const startupId = crypto.randomUUID();
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary"; cancel.textContent = "Cancel starting user";
    cancel.onclick = () => run(() => api.stopTaskActor(startupId));
    if (new FormData(form).get("mode") === "simulated") button.after(cancel);
    try {
      const data = Object.fromEntries(new FormData(form)); data.startupId = startupId; data.maxCompletions = Number(data.maxCompletions);
      if (data.mode === "simulated") data.actor = { model: data.actorModel, modelReasoningEffort: data.actorReasoning, exploration: data.exploration, meticulousness: data.meticulousness, maxActions: Number(data.maxActions) };
      const task = await api.createHumanTask(data); await list(); await inspect(task.id);
    } finally { cancel.remove(); button.disabled = false; }
  }); };
}
