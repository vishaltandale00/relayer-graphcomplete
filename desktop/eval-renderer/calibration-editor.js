import { authorizeExternalLiveSelection } from "./eval-live-authorization.js";
const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const criteria = ["answer_quality", "recursive_coherence", "navigation_value", "presentation_quality", "follow_up_progress"];
export function initializeCalibrationEditor({ api, root, toast }) {
  let draft = []; let sources = []; let current; let setups; let catalog;
  const run = async (work) => { try { await work(); } catch (error) { toast(error.message); } };
  async function open() {
    catalog = await api.calibrationCatalog(); setups = await api.setupRevisions();
    const tasks = await api.humanTasks(); const runs = await api.listRuns();
    sources = [...tasks.filter((item) => item.status === "completed").map((item) => ({ kind: "task", id: item.id, name: item.name })),
      ...runs.flatMap((item) => item.executions.filter((execution) => ["passed", "failed"].includes(execution.status)).map((execution) => ({ kind: "execution", id: execution.id, name: `${execution.testCaseId} · ${execution.harnessConfigurationName}` })))];
    root.innerHTML = `<h2>Calibration evidence</h2><button id="calibrationRefresh" class="secondary">Refresh evidence lists</button><p>Freeze recorded trajectories and human labels. Compare separately recorded results; freezing and creating comparisons start no inference. Explicit run buttons use the ordinary actor or judge authorization workflow. Held-out labels never enter actor observations or judge evaluation prompts.</p>
      <form id="calibrationMember"><label>Recorded trajectory<select name="source"><option value="">Choose…</option>${sources.map((item, index) => `<option value="${index}">${escape(item.kind)} · ${escape(item.name)} · ${escape(item.id)}</option>`).join("")}</select></label>
      <label>Membership<select name="membership"><option value="tuning">Tuning</option><option value="held-out">Held-out evaluation</option></select></label><button type="button" id="calibrationOpenSource" class="secondary">Open original evidence ↗</button><div id="calibrationLabels"></div><button class="secondary">Add labeled trajectory</button></form>
      <form id="calibrationFreeze"><label>Frozen set name<input name="name" required maxlength="200"></label><p id="calibrationDraft"></p><button class="primary">Freeze calibration set</button></form>
      <form id="calibrationCompare"><label>Frozen set<select name="calibrationSetId">${catalog.sets.map((item) => `<option value="${escape(item.id)}">${escape(item.name)} · ${escape(item.id)}</option>`).join("")}</select></label>
      <label>Proposed revision<select name="candidateRevisionId">${setups.revisions.filter((item) => item.predecessorId).map((item) => `<option value="${escape(item.id)}">${escape(item.kind)} · ${escape(item.name)} · ${escape(item.id)}</option>`).join("")}</select></label><p>Compare with this revision’s recorded predecessor. Actor realism uses independent human ratings; graph-judge agreement uses native v11 criterion scores against frozen human labels.</p><button class="primary">Create comparison</button></form>
      <label>Recorded comparison<select id="calibrationComparison"><option value="">Choose…</option>${catalog.comparisons.map((item) => `<option value="${escape(item.id)}">${escape(item.dimension)} · ${escape(item.id)}</option>`).join("")}</select></label><div id="calibrationReport"></div>
      <button id="calibrationExport" class="secondary">Export calibration evidence ↓</button><details><summary>Frozen sets, membership and labels</summary><pre>${escape(JSON.stringify(catalog.sets, null, 2))}</pre></details>`;
    root.querySelector("#calibrationRefresh").onclick = () => run(open);
    root.querySelector("#calibrationDraft").textContent = `${draft.length} trajectories in this draft`;
    root.querySelector('#calibrationMember [name="source"]').onchange = (event) => run(async () => {
      current = null;
      if (!event.target.value) { root.querySelector("#calibrationLabels").innerHTML = ""; return; }
      const ref = sources[Number(event.target.value)];
      current = { ref: { kind: ref.kind, id: ref.id }, snapshot: await api.calibrationSource(ref) };
      const dimension = ref.kind === "task" ? "actor-realism" : "graph-presentation";
      root.querySelector("#calibrationLabels").innerHTML = `<p>Human labels: ${dimension}. Leave value blank to preserve incomplete coverage. Human satisfaction stays separate.</p>
        <label>Evidence subject<select name="subject">${current.snapshot.subjects.map((item) => `<option value="${escape(item.id)}">${escape(item.kind)} · ${escape(item.id)}</option>`).join("")}</select></label>
        ${dimension === "graph-presentation" ? `<label>Graph criterion<select name="criterion">${criteria.map((item) => `<option>${item}</option>`).join("")}</select></label>` : ""}
        <label>Human rating (${dimension === "actor-realism" ? "1–4" : "ordered 1–8"})<input name="value" type="number" min="1" max="${dimension === "actor-realism" ? 4 : 8}"></label><label>Evidence-based label<textarea name="comment" maxlength="8000"></textarea></label>`;
    });
    root.querySelector("#calibrationOpenSource").onclick = () => run(() => current?.ref.kind === "task" ? api.openHumanTask(current.ref.id, true) : current ? api.openReview(current.ref.id) : Promise.reject(new Error("Choose a source first.")));
    root.querySelector("#calibrationMember").onsubmit = (event) => { event.preventDefault(); void run(async () => {
      if (!current) throw new Error("Choose a recorded trajectory.");
      const data = Object.fromEntries(new FormData(event.target)); const dimension = current.ref.kind === "task" ? "actor-realism" : "graph-presentation";
      const member = draft.find((item) => item.source.kind === current.ref.kind && item.source.id === current.ref.id);
      const label = data.value ? { dimension, scale: dimension === "actor-realism" ? "human-actor-realism-1-4" : "graph-presentation-v11-1-8", value: Number(data.value), comment: data.comment,
        subject: { kind: dimension === "actor-realism" ? "event" : "turn", id: data.subject }, ...(dimension === "graph-presentation" ? { criterion: data.criterion } : {}) } : null;
      if (member && member.membership !== data.membership) throw new Error("One trajectory cannot occupy both partitions.");
      if (member) { if (label) member.labels.push(label); }
      else draft.push({ source: current.ref, membership: data.membership, labels: label ? [label] : [] });
      root.querySelector("#calibrationDraft").textContent = `${draft.length} trajectories in this draft: ${draft.map((item) => `${item.membership}, ${item.labels.length} labels`).join("; ")}`;
    }); };
    root.querySelector("#calibrationFreeze").onsubmit = (event) => { event.preventDefault(); void run(async () => {
      const set = await api.freezeCalibrationSet({ name: new FormData(event.target).get("name"), members: draft }); draft = []; await open(); toast(`Frozen ${set.id}`);
    }); };
    root.querySelector("#calibrationCompare").onsubmit = (event) => { event.preventDefault(); void run(async () => {
      const data = Object.fromEntries(new FormData(event.target)); const candidate = setups.revisions.find((item) => item.id === data.candidateRevisionId);
      if (!candidate) throw new Error("Publish a proposed revision first.");
      const report = await api.compareSetupRevisions({ ...data, baselineRevisionId: candidate.predecessorId }); await open();
      root.querySelector("#calibrationComparison").value = report.comparison.id; await showReport(report.comparison.id);
    }); };
    root.querySelector("#calibrationComparison").onchange = (event) => run(() => showReport(event.target.value));
    root.querySelector("#calibrationExport").onclick = () => run(async () => {
      const bundle = await api.exportCalibration(); const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `calibration-${bundle.digest.slice(7)}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  async function showReport(id) {
    const container = root.querySelector("#calibrationReport"); if (!id) { container.innerHTML = ""; return; }
    const report = await api.calibrationReport(id);
    container.innerHTML = `<h3>${escape(report.comparison.dimension)} · ${escape(report.status)}</h3><p>Set ${escape(report.comparison.calibrationSetId)} · ${escape(report.comparison.calibrationSetDigest)}</p><pre>${escape(JSON.stringify(report.rows.map(({ baseline, candidate, ...row }) => ({ ...row, baseline: baseline ? { status: baseline.status, score: baseline.score, agreesWithHuman: baseline.agreesWithHuman } : null, candidate: candidate ? { status: candidate.status, score: candidate.score, agreesWithHuman: candidate.agreesWithHuman } : null })), null, 2))}</pre>
      <form id="calibrationObservation"><label>Frozen member and label<select name="row">${report.rows.filter((item) => item.labelId).map((item, index) => `<option value="${index}">${escape(item.membership)} · ${escape(item.memberId)} · ${escape(item.criterion || "actor realism")}</option>`).join("")}</select></label>
      <label>Evaluated revision<select name="revisionId">${[report.comparison.baseline, report.comparison.candidate].map((item) => `<option value="${escape(item.id)}">${escape(item.name)} · ${escape(item.id)}</option>`).join("")}</select></label>
      ${report.comparison.kind === "actor" ? '<label>Finished actor task ID<input name="taskId" required></label><label>Human realism rating (1–4)<input name="value" type="number" min="1" max="4" required></label><label>Evidence-based human rating<textarea name="comment" required maxlength="8000"></textarea></label>' : '<label>Recorded judge result ID<input name="judgeResultId" required></label><p>Use a separately authorized judge-only rerun against this original execution. Its exact revision, criterion, scale and screenshot coverage are checked. Target human labels are not passed to that judge.</p>'}
      <button type="button" id="calibrationRunArm" class="secondary">${report.comparison.kind === "actor" ? "Start actor task for this revision" : "Run judge on original graphs"}</button><button class="secondary">Record independent result</button></form>`;
    container.querySelector("#calibrationRunArm").onclick = () => run(async () => {
      const form = container.querySelector("#calibrationObservation"); const data = Object.fromEntries(new FormData(form));
      const row = report.rows.filter((item) => item.labelId)[Number(data.row)]; if (!row) throw new Error("Choose a frozen labeled member.");
      const set = catalog.sets.find((item) => item.id === report.comparison.calibrationSetId); const member = set.members.find((item) => item.id === row.memberId);
      if (report.comparison.kind === "actor") {
        if (member.source.kind !== "task") throw new Error("Actor execution requires a task-session seed.");
        const original = member.evidence.session;
        const external = Boolean(original.prepared.execution.catalogIdentity);
        if (!window.confirm(`Start a new candidate and actor task with the selected revision? This spends inference; completion limits are not cost limits.${external ? " Use the connected Codex subscription only; no API spending is authorized." : ""}`)) return;
        const liveAuthorization = external ? { confirmed: true, billingMode: "subscription-only",
          testCaseId: original.prepared.execution.testCaseId, harnessConfigurationName: original.prepared.execution.harnessConfigurationName,
          endpoint: original.endpoint, maxCompletions: original.maxCompletions, mode: "simulated" } : undefined;
        const task = await api.createHumanTask({ calibrationRef: { comparisonId: report.comparison.id, memberId: member.id, revisionId: data.revisionId }, liveAuthorization });
        form.elements.taskId.value = task.id; await api.openHumanTask(task.id, true);
        toast("Actor started. Grade realism after the task finishes.");
      } else {
        if (member.source.kind !== "execution") throw new Error("Judge execution requires original recorded graphs.");
        const execution = member.evidence.execution; const liveCatalog = await api.catalog();
        const selection = authorizeExternalLiveSelection({ testCaseIds: [execution.testCaseId], harnessConfigurationNames: [execution.harnessConfigurationName], judgeConfigurationName: "simulated-user" }, liveCatalog, {
          requestCostCap: (message) => window.prompt(message, "10.00"), confirmLiveRun: (message) => window.confirm(message),
        });
        if (selection === null || !window.confirm("Judge the original accepted graphs with this exact revision? This spends judge inference and appends separate evidence.")) return;
        await api.rejudgeExecution(member.source.id, "simulated-user", selection.liveAuthorization || null, data.revisionId);
        const runs = await api.listRuns(); const judged = runs.flatMap((run) => run.executions).find((item) => item.id === member.source.id);
        const result = judged.turns.find((turn) => String(turn.interactionId) === row.subject.id)?.judgeResults.findLast((item) => item.judgeSetup?.id === data.revisionId);
        if (!result) throw new Error("No judgment was recorded for this frozen subject.");
        form.elements.judgeResultId.value = result.id; toast("Judge result recorded. Attach it to the comparison.");
      }
    });
    container.querySelector("#calibrationObservation").onsubmit = (event) => { event.preventDefault(); void run(async () => {
      const data = Object.fromEntries(new FormData(event.target)); const row = report.rows.filter((item) => item.labelId)[Number(data.row)]; if (!row) throw new Error("No compatible frozen human labels.");
      await api.recordCalibrationObservation({ ...data, value: data.value ? Number(data.value) : undefined, comparisonId: id, memberId: row.memberId, labelId: row.labelId }); await showReport(id);
    }); };
  }
  return { open };
}
