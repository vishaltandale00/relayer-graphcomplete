import { runPanelCopy } from "./run-model.js";

const api = window.relayerEval;
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
let catalog;
let runs = [];
let selectedRunId = null;

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
  const panelCopy = runPanelCopy(run);
  $("#runPanelTitle").textContent = panelCopy.title;
  $("#runPanelDescription").textContent = panelCopy.description;
  $("#runTitle").textContent = run.id;
  $("#runMetadata").textContent = run.kind === "imported-conversation"
    ? `Imported conversation · ${run.sourceSha256}`
    : `${run.testCaseIds.length} cases × ${run.harnessConfigurationNames.length} harnesses · ${run.judgeConfigurationName}`;
  $("#runStatus").className = `status ${run.status}`;
  $("#runStatus").textContent = run.status;
  $("#aggregate").innerHTML = run.summary.byHarness.map((item) => {
    const percentage = item.total ? Math.round(item.passed / item.total * 100) : 0;
    return `<div class="metric"><small>${escapeHtml(item.name)}</small><strong>${item.passed}/${item.total}</strong><progress class="bar" max="100" value="${percentage}" aria-label="${percentage}% passed"></progress></div>`;
  }).join("");
  if (run.kind === "imported-conversation") {
    const execution = run.executions[0];
    $("#matrixHead").innerHTML = "<tr><th>External conversation</th><th>Review and judging</th></tr>";
    $("#matrixBody").innerHTML = `<tr><td><div class="case-copy"><b>${escapeHtml(run.title || "Imported conversation")}</b><small>Immutable owner export · ${escapeHtml(run.sourceSha256)}</small></div></td>${executionCellMarkup(run, execution, true)}</tr>`;
  } else {
    $("#matrixHead").innerHTML = `<tr><th>Test case</th>${run.harnessConfigurationNames.map((name) => `<th>${escapeHtml(name)}</th>`).join("")}</tr>`;
    $("#matrixBody").innerHTML = run.testCaseIds.map((caseId) => {
      const definition = catalog.cases.find((item) => item.id === caseId);
      const cells = run.harnessConfigurationNames.map((harness) => {
        const execution = run.executions.find((item) => item.testCaseId === caseId && item.harnessConfigurationName === harness);
        return executionCellMarkup(run, execution, false);
      }).join("");
      return `<tr><td><div class="case-copy"><b>${escapeHtml(definition?.name || caseId)}</b><small>${escapeHtml(caseId)}</small></div></td>${cells}</tr>`;
    }).join("");
  }
  document.querySelectorAll("[data-product-execution]:not(:disabled)").forEach((button) => {
    button.onclick = async () => {
      try { await api.openReview(button.dataset.productExecution); } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll("[data-annotation-export]:not(:disabled)").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        const exported = await api.exportAnnotations(button.dataset.annotationExport);
        toast(`Annotation export saved: ${exported.bundleRef}`);
      } catch (error) {
        toast(error.message);
      } finally {
        button.disabled = false;
      }
    };
  });
  document.querySelectorAll("[data-judge-execution]:not(:disabled)").forEach((button) => {
    button.onclick = async () => {
      try { await api.openJudgeReview(button.dataset.judgeExecution); } catch (error) { toast(error.message); }
    };
  });
  document.querySelectorAll("[data-run-imported-judge]:not(:disabled)").forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        const judged = await api.judgeImportedConversation(
          button.dataset.judgeExecutionId,
          button.dataset.runImportedJudge,
        );
        runs = await api.listRuns();
        renderRunList();
        renderRun(judged);
      } catch (error) {
        toast(error.message);
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    };
  });
  document.querySelectorAll("[data-trace-execution]:not(:disabled)").forEach((button) => {
    button.onclick = async () => {
      try { await api.openCandidateTrace(button.dataset.traceExecution); } catch (error) { toast(error.message); }
    };
  });
}

function executionCellMarkup(run, execution, imported) {
  const openable = execution?.threadIds?.length > 0;
  const score = execution?.checks?.length
    ? `${execution.checks.filter((check) => check.passed).length}/${execution.checks.length}`
    : "—";
  const traceable = execution?.turns?.some((turn) => turn.candidateTrace);
  const promotable = execution?.promotable !== false;
  const judgeEligible = imported && execution?.turns?.some((turn) => turn.status === "accepted");
  const hasJudgeOutput = execution?.turns?.some((turn) => turn.deterministicJudge || turn.judgeResults?.length);
  const judgeReviewable = imported ? hasJudgeOutput : Boolean(execution);
  const judgeActions = imported
    ? `<button class="open-review" data-run-imported-judge="deterministic-graph-contract" data-judge-execution-id="${escapeHtml(execution?.id)}" ${judgeEligible ? "" : "disabled"}>Run deterministic judge</button>${catalog.judges.some((judge) => judge.id === "simulated-user") ? `<button class="open-review" data-run-imported-judge="simulated-user" data-judge-execution-id="${escapeHtml(execution?.id)}" ${judgeEligible ? "" : "disabled"}>Run simulated-user judge</button>` : ""}`
    : `<button class="open-review" data-trace-execution="${escapeHtml(execution?.id)}" ${traceable ? "" : "disabled"}>Candidate trace ↗</button>`;
  return `<td><div class="execution-cell"><div class="execution" aria-label="Execution status and deterministic score"><b class="${escapeHtml(execution?.status)}">${escapeHtml(execution?.status || "missing")}</b><span>${score}</span>${promotable || imported ? "" : "<small>trace not promotable</small>"}</div><div class="execution-actions">${judgeActions}<button class="open-review" data-judge-execution="${escapeHtml(execution?.id)}" ${judgeReviewable ? "" : "disabled"}>Judge review ↗</button><button class="open-review" data-product-execution="${escapeHtml(execution?.id)}" ${openable ? "" : "disabled"}>Product workspace ↗</button><button class="open-review" data-annotation-export="${escapeHtml(execution?.id)}" ${openable ? "" : "disabled"}>Export annotations ↓</button></div></div></td>`;
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
  $("#importConversation").onclick = async () => {
    try {
      const run = await api.importConversation();
      if (!run) return;
      selectedRunId = run.id;
      runs = await api.listRuns();
      renderRunList();
      renderRun(run);
    } catch (error) { toast(error.message); }
  };
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
