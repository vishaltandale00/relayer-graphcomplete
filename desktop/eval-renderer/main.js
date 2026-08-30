import {
  projectExecutionCell,
  projectExecutionDossier,
  runPanelCopy,
} from "./run-model.js";
import {
  bindAblationControls,
  createRunFromControls,
  selectionFromControls,
} from "./configuration-model.js";

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
      <span>${escapeHtml(run.id)}</span><small>${escapeHtml(run.status)} · ${run.summary.byHarness.reduce((sum, item) => sum + (item.completed ?? item.finished ?? 0), 0)}/${run.summary.total} completed</small>
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
  $("#harnessOptions").innerHTML = catalog.harnessConfigurations.map((item) => optionMarkup({
    id: item.name,
    name: item.name,
    detail: `${item.implementation} · graph search ${item.graphCapabilityProfile?.search === "query-v1" ? "query-v1" : "off"}`,
  }, "harnesses", item.name === "fixture-task-system")).join("");
  $("#judgeOptions").innerHTML = catalog.judges.map((item, index) => optionMarkup(item, "judge", index === 0)).join("");
  $("#ablationOptions").innerHTML = (catalog.ablations || []).map((item) => `
    <button type="button" class="ablation-preset" data-ablation="${escapeHtml(item.id)}">
      <b>${escapeHtml(item.name)}</b><small>${escapeHtml(item.description)}</small><span>${item.harnessPairs.length} provider pairs</span>
    </button>`).join("");
  bindAblationControls(document, catalog, (selection) => {
    toast(`Selected ${selection.harnessConfigurationNames.length / 2} graph-search provider pairs.`);
  });
  show("configureView");
}

async function startRun() {
  const selection = selectionFromControls(document);
  if (!selection.testCaseIds.length || !selection.harnessConfigurationNames.length) return toast("Select at least one case and one harness.");
  $("#startRun").disabled = true;
  try {
    const run = await createRunFromControls(document, api);
    selectedRunId = run.id;
    selectedExecutionId = null;
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
    selectedExecutionId = null;
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
    const completed = item.completed ?? item.finished ?? 0;
    const percentage = item.total ? Math.round(completed / item.total * 100) : 0;
    const detail = item.outcomeJudged === undefined
      ? `${item.passed}/${item.total} legacy passes`
      : `${item.outcomeQualified}/${item.outcomeJudged} outcome-qualified · ${item.presentationJudged} graph-judged`;
    return `<div class="metric"><small>${escapeHtml(item.name)}</small><strong>${completed}/${item.total} completed</strong><span>${escapeHtml(detail)}</span><progress class="bar" max="100" value="${percentage}" aria-label="${percentage}% completed"></progress></div>`;
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
  const selectedExecution = run.executions.find((execution) => execution.id === selectedExecutionId);
  if (selectedExecution) renderExecutionDossier(run, selectedExecution);
  else {
    selectedExecutionId = null;
    $("#executionDossier").classList.add("hidden");
    $("#executionDossier").innerHTML = "";
  }
  document.querySelectorAll("[data-execution-detail]").forEach((button) => {
    button.onclick = () => {
      selectedExecutionId = button.dataset.executionDetail;
      renderRun(run);
      $("#executionDossier").scrollIntoView({ behavior: "smooth", block: "start" });
    };
  });
  document.querySelector("[data-close-dossier]")?.addEventListener("click", () => {
    selectedExecutionId = null;
    $("#executionDossier").classList.add("hidden");
    $("#executionDossier").innerHTML = "";
  });
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
  const cell = projectExecutionCell(run, execution);
  const selected = execution?.id === selectedExecutionId;
  const qualification = cell.substance.qualified === true
    ? "Qualified"
    : cell.substance.qualified === false ? "Not qualified" : "Qualification pending";
  return `<td><button type="button" class="execution-cell ${selected ? "selected" : ""}" data-execution-detail="${escapeHtml(execution?.id)}" aria-pressed="${selected}" aria-label="${escapeHtml(`${cell.lifecycle.label}. Substance ${cell.substance.label}, ${qualification}. Graph ${cell.presentation.label}. Open execution dossier.`)}">
    <span class="execution-heading"><b class="${escapeHtml(cell.lifecycle.status)}">${escapeHtml(cell.lifecycle.label)}</b><span>View evidence →</span></span>
    <span class="grade-row"><span><small>Substance</small><strong>${escapeHtml(cell.substance.label)}</strong></span><em class="${cell.substance.qualified === false ? "not-qualified" : cell.substance.qualified === true ? "qualified" : ""}">${escapeHtml(qualification)}</em></span>
    <span class="grade-row"><span><small>Graph</small><strong>${escapeHtml(cell.presentation.label)}</strong></span><em>${escapeHtml(cell.presentation.applicable ? cell.presentation.status : "Not applicable")}</em></span>
    ${execution?.promotable === false && !imported ? '<span class="cell-warning">Trace not promotable</span>' : ""}
  </button></td>`;
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs)) return "—";
  if (durationMs < 1000) return `${durationMs} ms`;
  const seconds = Math.round(durationMs / 100) / 10;
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function evidenceMarkup(references) {
  return references.length
    ? `<ul class="evidence-refs">${references.map((reference) => `<li><code>${escapeHtml(reference)}</code></li>`).join("")}</ul>`
    : '<p class="empty-note">No evidence references recorded.</p>';
}

function findingsMarkup(items, kind) {
  if (!items.length) return `<p class="empty-note">No ${escapeHtml(kind)} recorded.</p>`;
  return `<div class="finding-list">${items.map((item) => `<article class="finding-row ${escapeHtml(item.status)}">
    <div><span class="finding-status">${escapeHtml(item.status)}</span><b>${escapeHtml(item.label)}</b>${item.score === null ? "" : `<strong>${escapeHtml(item.score)}</strong>`}</div>
    ${item.detail ? `<p>${escapeHtml(item.detail)}</p>` : ""}
    ${item.evidenceRefs.length ? evidenceMarkup(item.evidenceRefs) : ""}
  </article>`).join("")}</div>`;
}

function worstLayerMarkup(worstLayer) {
  if (worstLayer === null || worstLayer === undefined) return "—";
  if (typeof worstLayer !== "object") return escapeHtml(worstLayer);
  const id = worstLayer.layerId ?? worstLayer.id ?? "Layer";
  return `${escapeHtml(id)}${Number.isFinite(worstLayer.score) ? ` · ${escapeHtml(worstLayer.score)}` : ""}`;
}

function aggregationLabel(aggregation) {
  if (typeof aggregation === "string") return aggregation;
  if (Array.isArray(aggregation)) return aggregation.length ? `${aggregation.length} recorded layer weights` : "—";
  return aggregation?.method ?? "—";
}

function renderExecutionDossier(run, execution) {
  const dossier = projectExecutionDossier(run, execution);
  const qualification = dossier.substance.qualified === true
    ? "Qualified"
    : dossier.substance.qualified === false ? "Not qualified" : "Not determined";
  const importedJudgeActions = run.kind === "imported-conversation"
    ? `<button class="secondary" data-run-imported-judge="deterministic-graph-contract" data-judge-execution-id="${escapeHtml(dossier.id)}" ${dossier.actions.importedJudgeEligible ? "" : "disabled"}>Run deterministic judge</button>${catalog.judges.some((judge) => judge.id === "simulated-user") ? `<button class="secondary" data-run-imported-judge="simulated-user" data-judge-execution-id="${escapeHtml(dossier.id)}" ${dossier.actions.importedJudgeEligible ? "" : "disabled"}>Run simulated-user judge</button>` : ""}`
    : "";
  const element = $("#executionDossier");
  element.classList.remove("hidden");
  element.innerHTML = `
    <header class="dossier-header"><div><span class="eyebrow">Execution dossier</span><h2>${escapeHtml(dossier.case.name)}</h2><p>${escapeHtml(dossier.case.id)} × ${escapeHtml(dossier.harness.name)}</p></div><button class="icon-button" data-close-dossier aria-label="Close execution dossier">×</button></header>
    <section class="dossier-summary">
      <div><small>Lifecycle</small><strong class="${escapeHtml(dossier.lifecycle.status)}">${escapeHtml(dossier.lifecycle.label)}</strong><span>${escapeHtml(formatDuration(dossier.lifecycle.durationMs))}</span></div>
      <div><small>Substance</small><strong>${escapeHtml(dossier.substance.label)}</strong><span class="${dossier.substance.qualified === false ? "not-qualified" : "qualified"}">${escapeHtml(qualification)}</span></div>
      <div><small>Graph presentation</small><strong>${escapeHtml(dossier.presentation.label)}</strong><span>${escapeHtml(dossier.presentation.applicable ? dossier.presentation.status : "Not applicable")}</span></div>
    </section>
    ${dossier.error ? `<p class="dossier-error"><b>Execution failed:</b> ${escapeHtml(dossier.error)}</p>` : ""}
    <section class="dossier-block"><div class="block-heading"><span class="eyebrow">Case contract</span><h3>Visible task and identity</h3></div>
      <blockquote>${escapeHtml(dossier.case.prompt || "No visible prompt was captured in this run record.")}</blockquote>
      <dl class="metadata-grid">
        <div><dt>Case version</dt><dd>${escapeHtml(dossier.case.version || "—")}</dd></div><div><dt>Authoring status</dt><dd>${escapeHtml(dossier.case.authoringStatus === "human_reviewed" ? "Human reviewed" : dossier.case.authoringStatus === "candidate" ? "Candidate · calibration only" : "—")}</dd></div>
        <div><dt>Case digest</dt><dd><code>${escapeHtml(dossier.case.digest || "—")}</code></dd></div>
        <div><dt>Repository</dt><dd>${escapeHtml(dossier.case.repository || "—")}</dd></div><div><dt>Commit</dt><dd><code>${escapeHtml(dossier.case.commit || "—")}</code></dd></div>
        <div><dt>Harness</dt><dd>${escapeHtml(dossier.harness.implementation || dossier.harness.name)}</dd></div><div><dt>Harness digest</dt><dd><code>${escapeHtml(dossier.harness.digest || "—")}</code></dd></div>
      </dl>
    </section>
    <section class="dossier-columns">
      <article class="dossier-block"><div class="block-heading"><span class="eyebrow">Verifiable substance</span><h3>Mandatory gates</h3></div><dl class="metadata-grid"><div><dt>Verifier</dt><dd>${escapeHtml(dossier.substance.verifierId || "—")}</dd></div><div><dt>Verifier digest</dt><dd><code>${escapeHtml(dossier.substance.verifierDigest || "—")}</code></dd></div><div><dt>Outcome rubric</dt><dd>${escapeHtml(dossier.substance.rubricVersion || "—")}</dd></div></dl>${findingsMarkup(dossier.substance.gates, "gates")}<div class="block-heading subheading"><h3>Outcome criteria</h3></div>${findingsMarkup(dossier.substance.criteria, "criteria")}<div class="block-heading subheading"><h3>Outcome evidence</h3></div>${evidenceMarkup(dossier.substance.evidenceRefs)}</article>
      <article class="dossier-block"><div class="block-heading"><span class="eyebrow">Graph presentation</span><h3>Presentation summary</h3></div>
        ${dossier.presentation.applicable ? `<dl class="metadata-grid presentation-metadata"><div><dt>Final score</dt><dd>${escapeHtml(dossier.presentation.label)}</dd></div><div><dt>Comprehension</dt><dd>${escapeHtml(dossier.presentation.comprehensionScore ?? "—")}</dd></div><div><dt>Rendered experience</dt><dd>${escapeHtml(dossier.presentation.renderedScore ?? "—")}</dd></div><div><dt>Raw score</dt><dd>${escapeHtml(dossier.presentation.rawScore ?? "—")}</dd></div><div><dt>Omission ceiling</dt><dd>${escapeHtml(dossier.presentation.scoreCeiling ?? "None")}</dd></div><div><dt>Depth decay</dt><dd>${escapeHtml(dossier.presentation.decay ?? "—")}</dd></div><div><dt>Worst layer</dt><dd>${worstLayerMarkup(dossier.presentation.worstLayer)}</dd></div><div><dt>Materially misleading layer</dt><dd>${escapeHtml(dossier.presentation.hasMateriallyMisleadingLayer === null ? "—" : dossier.presentation.hasMateriallyMisleadingLayer ? "Yes" : "No")}</dd></div><div><dt>Graded layers</dt><dd>${escapeHtml(dossier.presentation.layers.length || "—")}</dd></div><div><dt>Aggregation</dt><dd>${escapeHtml(dossier.presentation.aggregationMethod === "recursive_semantic_root" ? "Recursive semantic root" : aggregationLabel(dossier.presentation.aggregation))}</dd></div></dl>${evidenceMarkup(dossier.presentation.evidenceRefs)}` : '<p class="empty-note">Graph presentation does not apply to this harness.</p>'}
      </article>
    </section>
    <footer class="dossier-actions">${importedJudgeActions}<button class="secondary" data-trace-execution="${escapeHtml(dossier.id)}" ${dossier.actions.traceable ? "" : "disabled"}>Candidate trace ↗</button><button class="secondary" data-judge-execution="${escapeHtml(dossier.id)}" ${dossier.actions.judgeReviewable ? "" : "disabled"}>Judge review ↗</button><button class="secondary" data-product-execution="${escapeHtml(dossier.id)}" ${dossier.actions.workspaceReviewable ? "" : "disabled"}>Product workspace ↗</button><button class="secondary" data-annotation-export="${escapeHtml(dossier.id)}" ${dossier.actions.annotationExportable ? "" : "disabled"}>Export annotations ↓</button></footer>`;
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
      selectedExecutionId = null;
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
