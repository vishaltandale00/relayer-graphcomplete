const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
export function initializeSetupEditor({ api, root, toast, changed }) {
  let catalog;
  let source;
  let feedback = [];
  let judgeConfig;
  const run = async (work) => { try { await work(); } catch (error) { toast(error.message); } };
  async function open(predecessorId, configFile) {
    catalog = await api.setupRevisions();
    source = catalog.revisions.find((item) => item.id === predecessorId) || catalog.revisions.at(-1);
    feedback = [];
    const fileConfigs = source.kind === "completion-judge" ? catalog.completionJudgeConfigs : source.kind === "judge" ? catalog.judgeConfigs : null;
    judgeConfig = fileConfigs?.find((item) => item.file === (configFile || source.configSource?.file)) || fileConfigs?.[0] || null;
    root.innerHTML = `<h2>Setup revisions</h2><p>Publishing saves an immutable revision. Select it on a new run to execute it. Graph-presentation judging remains separate from overall trajectory judging.</p>
      <label>Predecessor<select id="setupPredecessor">${catalog.revisions.map((item) => `<option value="${escape(item.id)}">${escape(item.kind)} · ${escape(item.name)} · ${escape(item.id)}</option>`).join("")}</select></label>
      ${fileConfigs ? `<label>${source.kind === "completion-judge" ? "Completion judge" : "Graph judge"} config file<select id="judgeConfigFile">${fileConfigs.map((item) => `<option value="${escape(item.file)}">${escape(item.file)}</option>`).join("")}</select></label><p>Edit <code>${escape(judgeConfig.path)}</code>, then reload this panel. Publication pins its exact bytes and digest.</p>` : ""}
      ${source.kind === "actor" ? `<button type="button" id="setupUseCurrentActor">Use current actor and completion reviewer</button>` : ""}
      <form id="setupPublish">${judgeConfig ? `<p>Config digest: <code>${escape(judgeConfig.digest)}</code></p>` : `<label>Revision name<input name="name" value="${escape(source.name)}" required maxlength="200"></label>
      <label>Prompt version<input name="promptVersion" value="${escape(source.promptVersion)}" required maxlength="100"></label>
      <label>Model<input name="model" value="${escape(source.settings.model)}" required></label>
      <label>Reasoning<select name="modelReasoningEffort">${["low", "medium", "high"].map((value) => `<option ${source.settings.modelReasoningEffort === value ? "selected" : ""}>${value}</option>`).join("")}</select></label>
      <label>Exploration<select name="exploration">${["low", "medium", "high"].map((value) => `<option ${source.settings.exploration === value ? "selected" : ""}>${value}</option>`).join("")}</select></label><label>Meticulousness<select name="meticulousness">${["low", "medium", "high"].map((value) => `<option ${source.settings.meticulousness === value ? "selected" : ""}>${value}</option>`).join("")}</select></label><label>Action limit<input name="maxActions" type="number" value="${source.settings.maxActions}" min="1" max="500"></label><label>Deadline in minutes (including startup)<input name="timeoutMinutes" type="number" value="${source.settings.timeoutMs / 60000}" min="1" max="60" step="any" required></label>
      ${source.behaviorContract?.completionJudge ? `<p id="setupCompletionReviewer">Completion reviewer: ${escape(source.behaviorContract.completionJudge.model)} · ${escape(source.behaviorContract.completionJudge.modelReasoningEffort)} reasoning · ${escape(source.behaviorContract.completionJudge.version)}. This revision requires its approval to finish.</p>` : `<p id="setupCompletionReviewer">This historical revision lets the actor decide when to finish.</p>`}
      <label>Prompt template<textarea name="promptTemplate" rows="10" maxlength="100000" required>${escape(source.promptTemplate)}</textarea></label>
      <p>Keep the {{runtime}} variables. Task evidence is supplied at execution, without feedback lineage or human target grades.</p>`}
      <p>Select motivating human feedback before publishing.</p>
      <label>Human feedback session<select id="setupFeedbackSession"><option value="">Choose…</option></select></label><div id="setupFeedbackRecords"></div>
      <button class="primary">Publish new revision</button><output id="setupPublished"></output></form>
      <details><summary>Pinned contract, lineage and revision history</summary><pre>${escape(JSON.stringify(source, null, 2))}</pre></details>
      ${source.kind === "completion-judge" ? "" : `<form id="setupPromote"><p>Promotion changes the default for future runs. It does not certify calibration or change earlier evidence.</p><label>Human decision<textarea name="comment" required maxlength="8000"></textarea></label><button class="secondary">Promote this revision</button></form>`}
      <form id="evaluatorReleasePublish"><h3>Publish evaluator release</h3><p>Pin all three revisions explicitly. Publication does not change defaults or start a run. The graph-presentation judge is pinned for later explicit grading.</p><label>Release predecessor<select name="predecessorId"><option value="">Initial release</option>${(catalog.evaluatorReleases || []).map((item) => `<option value="${escape(item.id)}">${escape(item.name)} · ${escape(item.id)}</option>`).join("")}</select></label><label>Release name<input name="name" required maxlength="200"></label>${[["actor", "actorRevisionId", "Actor"], ["completion-judge", "completionJudgeRevisionId", "Completion judge"], ["judge", "judgeRevisionId", "Graph-presentation judge"]].map(([kind, name, label]) => `<label>${label}<select name="${name}" required><option value="">Choose…</option>${catalog.revisions.filter((item) => item.kind === kind).map((item) => `<option value="${escape(item.id)}">${escape(item.name)} · ${escape(item.id)}</option>`).join("")}</select></label>`).join("")}<button class="primary">Publish evaluator release</button><output id="evaluatorReleasePublished"></output></form>`;
    root.querySelector("#setupPredecessor").value = source.id;
    root.querySelector("#setupPredecessor").onchange = (event) => run(() => open(event.target.value));
    if (judgeConfig) {
      root.querySelector("#judgeConfigFile").value = judgeConfig.file;
      root.querySelector("#judgeConfigFile").onchange = (event) => run(() => open(source.id, event.target.value));
    }
    const sessions = await api.humanTasks();
    root.querySelector("#setupFeedbackSession").innerHTML += sessions.map((item) => `<option value="${escape(item.id)}">${escape(item.name)} · ${escape(item.id)}</option>`).join("");
    root.querySelector("#setupFeedbackSession").onchange = (event) => run(async () => {
      feedback = []; const session = event.target.value ? await api.humanTask(event.target.value) : null;
      const refs = [...(session?.annotations || []).map((item) => ({ ref: { sessionId: session.id, annotationId: item.id }, label: `${item.eventId}: ${item.comment}` })), ...(session?.grades || []).map((item, gradeIndex) => ({ ref: { sessionId: session.id, gradeIndex }, label: `Human satisfaction ${item.value}: ${item.comment}` }))];
      const records = root.querySelector("#setupFeedbackRecords");
      records.innerHTML = refs.map((item, index) => `<label><input type="checkbox" value="${index}"> ${escape(item.label)}</label>`).join("") || "No human feedback in this session.";
      records.onchange = () => { feedback = [...records.querySelectorAll("input:checked")].map((input) => refs[Number(input.value)].ref); };
    });
    const upgradeActor = root.querySelector("#setupUseCurrentActor");
    if (upgradeActor) upgradeActor.onclick = () => {
      const definition = catalog.actorDefinition;
      root.querySelector('[name="promptVersion"]').value = definition.promptVersion;
      root.querySelector('[name="promptTemplate"]').value = definition.promptTemplate;
      root.querySelector("#setupCompletionReviewer").textContent = `Pending new revision: ${definition.behaviorContract.completionJudge.model} · ${definition.behaviorContract.completionJudge.modelReasoningEffort} completion review. Publish to save; existing runs stay unchanged.`;
      toast(`New revision will use ${definition.behaviorContract.completionJudge.model} completion review. Select feedback and publish to save it.`);
    };
    root.querySelector("#setupPublish").onsubmit = (event) => { event.preventDefault(); void run(async () => {
      const data = Object.fromEntries(new FormData(event.target));
      const revision = await api.publishSetup(judgeConfig ? { kind: source.kind, configFile: judgeConfig.file, configDigest: judgeConfig.digest, predecessorId: source.id, feedback } : { ...source, name: data.name, promptVersion: data.promptVersion,
        promptTemplate: data.promptTemplate, ...(source.kind === "judge" ? { inputPromptTemplate: data.inputPromptTemplate } : {}),
        settings: { ...source.settings, model: data.model, modelReasoningEffort: data.modelReasoningEffort,
          ...(source.kind === "actor" ? { exploration: data.exploration, meticulousness: data.meticulousness, maxActions: Number(data.maxActions), timeoutMs: Math.round(Number(data.timeoutMinutes) * 60000) } : {}) },
        predecessorId: source.id, feedback });
      await changed(); await open(revision.id); root.querySelector("#setupPublished").textContent = `Published ${revision.id}`;
    }); };
    const promote = root.querySelector("#setupPromote");
    if (promote) promote.onsubmit = (event) => { event.preventDefault(); void run(async () => {
      await api.promoteSetup({ revisionId: source.id, comment: new FormData(event.target).get("comment") });
      await changed(); toast("Revision promoted for future default selection.");
    }); };
    root.querySelector("#evaluatorReleasePublish").onsubmit = (event) => { event.preventDefault(); void run(async () => {
      const input = Object.fromEntries(new FormData(event.target));
      if (!input.predecessorId) delete input.predecessorId;
      const release = await api.publishEvaluatorRelease(input);
      await changed(); await open(source.id); root.querySelector("#evaluatorReleasePublished").textContent = `Published ${release.id}`;
    }); };
  }
  return { open };
}
