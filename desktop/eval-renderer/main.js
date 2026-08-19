const api = window.relayerEval;
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
let catalog;
let runs = [];
let selectedRunId = null;
let selectedExecutionId = null;

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.remove("hidden");
  setTimeout(() => $("#toast").classList.add("hidden"), 3000);
}

function show(view) {
  for (const id of ["emptyView", "configureView", "runView"]) $(`#${id}`).classList.toggle("hidden", id !== view);
}

function renderRunList() {
  $("#runList").innerHTML = runs.length ? runs.map((run) => `
    <button class="run-entry ${run.id === selectedRunId ? "active" : ""}" data-run="${escapeHtml(run.id)}">
      <span>${escapeHtml(run.id)}</span><small>${escapeHtml(run.status)} · ${run.summary.passed}/${run.summary.total} passed</small>
    </button>`).join("") : `<div class="run-entry"><small>No test runs yet</small></div>`;
  document.querySelectorAll("[data-run]").forEach((button) => {
    button.onclick = () => selectRun(button.dataset.run);
  });
}

function optionMarkup({ id, name, description, detail }, group, checked) {
  return `<label class="option"><input type="${group === "judge" ? "radio" : "checkbox"}" name="${group}" value="${escapeHtml(id)}" ${checked ? "checked" : ""}/><div><b>${escapeHtml(name)}</b><small>${escapeHtml(description || detail || "")}</small></div></label>`;
}

function configure() {
  $("#caseOptions").innerHTML = catalog.cases.map((item) => optionMarkup(item, "cases", true)).join("");
  $("#harnessOptions").innerHTML = catalog.harnessConfigurations.map((item) => optionMarkup({ id: item.name, name: item.name, detail: item.implementation }, "harnesses", item.name === "fixture-task-system")).join("");
  $("#judgeOptions").innerHTML = catalog.judges.map((item, index) => optionMarkup(item, "judge", index === 0)).join("");
  show("configureView");
}

async function startRun() {
  const values = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
  const selection = {
    testCaseIds: values("cases"),
    harnessConfigurationNames: values("harnesses"),
    judgeConfigurationName: values("judge")[0],
  };
  if (!selection.testCaseIds.length || !selection.harnessConfigurationNames.length) return toast("Select at least one case and one harness.");
  $("#startRun").disabled = true;
  try {
    const run = await api.createRun(selection);
    selectedRunId = run.id;
    runs = await api.listRuns();
    renderRunList();
    renderRun(run);
  } catch (error) {
    toast(error.message);
  } finally {
    $("#startRun").disabled = false;
  }
}

async function selectRun(runId) {
  try {
    selectedRunId = runId;
    renderRunList();
    renderRun(await api.getRun(runId));
  } catch (error) { toast(error.message); }
}

function renderRun(run) {
  show("runView");
  $("#runTitle").textContent = run.id;
  $("#runMetadata").textContent = `${run.testCaseIds.length} cases × ${run.harnessConfigurationNames.length} harnesses · ${run.judgeConfigurationName}`;
  $("#runStatus").className = `status ${run.status}`;
  $("#runStatus").textContent = run.status;
  $("#aggregate").innerHTML = run.summary.byHarness.map((item) => {
    const percentage = item.total ? Math.round(item.passed / item.total * 100) : 0;
    return `<div class="metric"><small>${escapeHtml(item.name)}</small><strong>${item.passed}/${item.total}</strong><progress class="bar" max="100" value="${percentage}" aria-label="${percentage}% passed"></progress></div>`;
  }).join("");
  $("#matrixHead").innerHTML = `<tr><th>Test case</th>${run.harnessConfigurationNames.map((name) => `<th>${escapeHtml(name)}</th>`).join("")}</tr>`;
  $("#matrixBody").innerHTML = run.testCaseIds.map((caseId) => {
    const definition = catalog.cases.find((item) => item.id === caseId);
    const cells = run.harnessConfigurationNames.map((harness) => {
      const execution = run.executions.find((item) => item.testCaseId === caseId && item.harnessConfigurationName === harness);
      const openable = execution?.threadIds?.length > 0;
      const score = execution?.checks?.length ? `${execution.checks.filter((check) => check.passed).length}/${execution.checks.length}` : "—";
      return `<td><div class="execution-cell"><button class="execution" data-judge-output="${escapeHtml(execution?.id)}" ${execution ? "" : "disabled"}><b class="${escapeHtml(execution?.status)}">${escapeHtml(execution?.status || "missing")}</b><span>${score}</span></button><button class="open-review" data-execution="${escapeHtml(execution?.id)}" ${openable ? "" : "disabled"}>See in App ↗</button></div></td>`;
    }).join("");
    return `<tr><td><div class="case-copy"><b>${escapeHtml(definition?.name || caseId)}</b><small>${escapeHtml(caseId)}</small></div></td>${cells}</tr>`;
  }).join("");
  document.querySelectorAll("[data-execution]:not(:disabled)").forEach((button) => {
    button.onclick = async () => {
      try { await api.openReview(button.dataset.execution); } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll("[data-judge-output]:not(:disabled)").forEach((button) => {
    button.onclick = () => {
      selectedExecutionId = button.dataset.judgeOutput;
      renderJudgeOutput(run, selectedExecutionId);
    };
  });
  const selectedExecution = run.executions.find((execution) => execution.id === selectedExecutionId)
    ?? run.executions.find((execution) => execution.turns?.some((turn) => turn.judgeResults?.length));
  if (selectedExecution) {
    selectedExecutionId = selectedExecution.id;
    renderJudgeOutput(run, selectedExecution.id);
  } else {
    selectedExecutionId = null;
    $("#judgeOutputPanel").classList.add("hidden");
  }
}

function renderJudgeOutput(run, executionId) {
  const execution = run.executions.find((candidate) => candidate.id === executionId);
  if (!execution) return $("#judgeOutputPanel").classList.add("hidden");
  const judgeResults = (execution.turns || []).flatMap((turn, turnIndex) => (
    (turn.judgeResults || []).map((result) => ({ result, turn, turnIndex }))
  ));
  $("#judgeOutputPanel").classList.remove("hidden");
  $("#judgeOutputTitle").textContent = `${execution.testCaseId} · ${execution.harnessConfigurationName}`;
  $("#judgeOutputMetadata").textContent = `${execution.status} · ${execution.checks?.filter((check) => check.passed).length || 0}/${execution.checks?.length || 0} deterministic checks passed`;
  if (!judgeResults.length) {
    $("#judgeOutput").innerHTML = `<div class="judge-empty"><b>No simulated-user review for this execution.</b><p>The selected judge was ${escapeHtml(run.judgeConfigurationName)}.</p></div>`;
    return;
  }
  $("#judgeOutput").innerHTML = judgeResults.map(({ result, turn, turnIndex }) => {
    const finalReview = result.review?.turn ?? result.review?.turnReview ?? result.review?.review ?? result.review ?? null;
    const ratings = ratingMarkup(finalReview?.ratings);
    const subjectReviews = lowerSubjectReviewMarkup(result.review);
    const references = Object.entries(result.references || {}).flatMap(([name, value]) => {
      const values = Array.isArray(value) ? value : [value];
      return values.filter(Boolean).map((reference) => `<li><span>${escapeHtml(name)}</span><code>${escapeHtml(reference)}</code></li>`);
    }).join("");
    return `<article class="judge-card">
      <div class="judge-card-heading"><div><span>Turn ${turnIndex + 1}</span><b>${escapeHtml(turn.prompt || turn.interactionId || "Completed turn")}</b></div><strong class="${escapeHtml(result.status)}">${escapeHtml(result.status)}</strong></div>
      <p class="judge-summary">${escapeHtml(result.summary || finalReview?.summary || result.error || "The judge did not return a summary.")}</p>
      ${result.error && result.summary ? `<p class="judge-error">${escapeHtml(result.error)}</p>` : ""}
      ${ratings ? `<div class="judge-section"><h3>Overall ratings</h3><ul class="rating-list">${ratings}</ul></div>` : ""}
      ${subjectReviews ? `<details class="judge-section subject-reviews"><summary>Layer, node, and action reviews</summary>${subjectReviews}</details>` : ""}
      ${references ? `<details class="judge-section"><summary>Immutable artifacts</summary><ul class="artifact-list">${references}</ul></details>` : ""}
    </article>`;
  }).join("");
}

function ratingMarkup(ratings) {
  if (!ratings || typeof ratings !== "object") return "";
  return Object.entries(ratings).map(([criterion, rating]) => `<li><span>${escapeHtml(criterion.replaceAll("_", " "))}</span><b>${rating === null ? "N/A" : escapeHtml(rating)}</b></li>`).join("");
}

function lowerSubjectReviewMarkup(review) {
  if (!review || typeof review !== "object") return "";
  const subjects = [
    ...(review.layers || []).map((entry) => ({
      kind: "Layer",
      id: entry.subject?.layerId ?? entry.history?.current?.layerId,
      review: entry.history?.current,
    })),
    ...(review.nodes || []).flatMap((entry) => {
      const current = entry.history?.current;
      const node = [{ kind: "Node", id: current?.nodeId ?? entry.subject?.nodeId, review: current }];
      const actions = (current?.actions || []).map((action) => ({
        kind: action.kind === "navigate" ? "Navigate action" : "Invoke action",
        id: action.actionId,
        review: action,
      }));
      return [...node, ...actions];
    }),
  ].filter((subject) => subject.review);
  return subjects.map((subject) => `<article class="subject-review">
    <div><span>${escapeHtml(subject.kind)}</span><code>${escapeHtml(subject.id)}</code></div>
    <p>${escapeHtml(subject.review.summary || "No summary.")}</p>
    <ul class="rating-list">${ratingMarkup(subject.review.ratings)}</ul>
  </article>`).join("");
}

async function boot() {
  catalog = await api.catalog();
  runs = await api.listRuns();
  renderRunList();
  api.onRunsChanged((nextRuns) => {
    runs = nextRuns;
    renderRunList();
    const selected = runs.find((run) => run.id === selectedRunId);
    if (selected) renderRun(selected);
  });
  $("#newRun").onclick = configure;
  $("#emptyNewRun").onclick = configure;
  $("#cancelRun").onclick = () => selectedRunId ? selectRun(selectedRunId) : show("emptyView");
  $("#startRun").onclick = startRun;
  show(runs.length ? "runView" : "emptyView");
  if (runs.length) {
    selectedRunId = runs[0].id;
    renderRunList();
    renderRun(runs[0]);
  }
}

void boot().catch((error) => toast(error.message));
