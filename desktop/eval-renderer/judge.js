import {
  buildJudgeAnalysis,
  scoreForRatings,
  subjectForSelection,
} from "./judge-model.js";

const api = window.relayerEval;
const app = document.querySelector("#app");
const dialog = document.querySelector("#evidenceDialog");
const dialogTitle = document.querySelector("#evidenceDialogTitle");
const dialogBody = document.querySelector("#evidenceDialogBody");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
})[character]);

const state = {
  analysis: null,
  selectedTurn: 0,
  selection: { kind: "turn" },
  evidenceMode: "subject",
  screenshots: new Map(),
  pendingScreenshots: new Set(),
};

function titleCase(value) {
  return String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function scoreLabel(ratings) {
  const score = scoreForRatings(ratings);
  return score === null ? "—" : score.toFixed(1);
}

function statusMarkup(turn) {
  return `<span class="review-status ${escapeHtml(turn.state)}">${escapeHtml(turn.stateLabel)}</span>`;
}

function coverageMarkup(coverage) {
  if (!coverage) return "";
  const groups = ["layers", "nodes", "actions", "turn"].flatMap((name) => {
    const item = coverage[name];
    return item ? [`<span><b>${escapeHtml(item.reviewed ?? 0)}/${escapeHtml(item.required ?? 0)}</b> ${escapeHtml(name)}</span>`] : [];
  });
  return groups.length ? `<div class="coverage-strip">${groups.join("")}</div>` : "";
}

function breadcrumbMarkup(turn, subject) {
  const segments = [
    { label: state.analysis.runId, title: "Test run" },
    { label: state.analysis.execution.testCaseId, title: "Test case" },
    { label: state.analysis.execution.harnessConfigurationName, title: "Harness" },
    { label: turn.threadDefinitionId || `Thread ${turn.threadId}`, title: "Thread" },
    { label: `Turn ${(turn.threadTurnIndex ?? turn.turnIndex) + 1}`, title: "Turn", action: "turn" },
  ];
  if (subject?.kind === "layer" || subject?.layerId) {
    segments.push({ label: `Layer ${subject.layerId}`, title: "Layer", action: "layer", layerId: subject.layerId });
  }
  if (subject?.kind === "node" || subject?.nodeId) {
    segments.push({ label: `Node ${subject.nodeId}`, title: "Node", action: "node", layerId: subject.layerId, nodeId: subject.nodeId });
  }
  if (subject?.kind === "action") segments.push({ label: `${titleCase(subject.actionKind)} action ${subject.actionId}`, title: "Action" });
  return segments.map((segment, index) => {
    const attributes = segment.action
      ? `data-crumb-kind="${segment.action}" data-layer-id="${escapeHtml(segment.layerId)}" data-node-id="${escapeHtml(segment.nodeId)}"`
      : "disabled";
    return `<li>${index ? '<span aria-hidden="true">/</span>' : ""}<button ${attributes} title="${escapeHtml(segment.title)}">${escapeHtml(segment.label)}</button></li>`;
  }).join("");
}

function turnMarkup(turn) {
  const active = turn.position === state.selectedTurn;
  return `<button class="turn-tab ${active ? "active" : ""}" data-turn="${turn.position}" aria-pressed="${active}">
    <span>${escapeHtml(turn.threadDefinitionId || `Thread ${turn.threadId}`)} · Turn ${(turn.threadTurnIndex ?? turn.turnIndex) + 1}</span>
    <b>${escapeHtml(turn.prompt || `Interaction ${turn.interactionId}`)}</b>
    ${statusMarkup(turn)}
  </button>`;
}

function nodeChipMarkup(node) {
  const active = state.selection.kind !== "layer" && state.selection.layerId === node.layerId && state.selection.nodeId === node.nodeId;
  const label = node.review
    ? `Node ${node.nodeId}, score ${scoreLabel(node.review.ratings)}`
    : `Node ${node.nodeId}, not reviewed`;
  return `<button class="node-chip ${active ? "active" : ""} ${node.reviewed ? "" : "missing"}" data-node-id="${escapeHtml(node.nodeId)}" data-layer-id="${escapeHtml(node.layerId)}" aria-label="${escapeHtml(label)}">
    <span>Node ${escapeHtml(node.nodeId)}</span><b>${node.reviewed ? scoreLabel(node.review?.ratings) : "Not reviewed"}</b>
  </button>`;
}

function layerMarkup(layer) {
  const active = state.selection.layerId === layer.layerId;
  const recursiveSlots = Array.isArray(layer.review?.nodeScores)
    ? `<div class="node-chips recursive-slots" aria-label="Eight aligned node result slots">${layer.review.nodeScores.map((score, index) => {
        const semantic = layer.review.nodeSemantics?.[index] ?? null;
        const node = score ? layer.nodes.find((candidate) => candidate.nodeId === String(score.nodeId)) : null;
        return node
          ? `<div class="recursive-slot"><small>Slot ${index + 1}</small>${nodeChipMarkup(node)}<dl><div><dt>C</dt><dd>${escapeHtml(score.content)}</dd></div><div><dt>A</dt><dd>${escapeHtml(score.actionAllocation)}</dd></div><div><dt>D</dt><dd>${score.actionDelivery === null ? "N/A" : escapeHtml(score.actionDelivery)}</dd></div><div><dt>R</dt><dd>${score.recursiveQuality === null ? "N/A" : escapeHtml(score.recursiveQuality)}</dd></div></dl><p>${escapeHtml(semantic?.effectOnLayer || semantic?.delivered || "No aligned semantic summary")}</p></div>`
          : `<span class="recursive-slot empty-slot"><small>Slot ${index + 1}</small><b>Score null</b><p>Semantic null</p></span>`;
      }).join("")}</div>`
    : `<div class="node-chips" aria-label="Nodes in layer ${escapeHtml(layer.layerId)}">${layer.nodes.map(nodeChipMarkup).join("") || '<span class="empty-note">No inventoried nodes</span>'}</div>`;
  return `<article class="layer-card ${active ? "active" : ""} ${layer.reviewed ? "" : "missing"}">
    <button class="layer-heading" data-layer-id="${escapeHtml(layer.layerId)}">
      <span><small>Depth ${escapeHtml(layer.depth)}</small><b>Layer ${escapeHtml(layer.layerId)}</b></span>
      <strong>${layer.reviewed ? scoreLabel(layer.review?.ratings) : "Not reviewed"}</strong>
    </button>
    <p>${escapeHtml(layer.review?.summary || "The judge did not submit a review for this layer.")}</p>
    ${recursiveSlots}
  </article>`;
}

function ratingsMarkup(review) {
  if (!review?.ratings || typeof review.ratings !== "object") return '<p class="empty-note">No criterion scores were submitted.</p>';
  return `<dl class="ratings">${Object.entries(review.ratings).map(([criterion, rating]) => `<div><dt>${escapeHtml(titleCase(criterion))}</dt><dd>${rating === null ? "N/A" : escapeHtml(rating)}</dd></div>`).join("")}</dl>`;
}

function findingsMarkup(review) {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  if (!findings.length) return '<p class="empty-note">No findings were submitted.</p>';
  return `<ul class="findings">${findings.map((finding) => `<li class="${escapeHtml(finding.type)}"><span>${escapeHtml(finding.type === "issue" ? finding.severity || "issue" : "strength")}</span><p>${escapeHtml(finding.text)}</p></li>`).join("")}</ul>`;
}

function actionsMarkup(subject) {
  if (subject?.kind !== "node" || !subject.actions.length) return "";
  return `<section class="detail-section"><h3>Actions</h3><div class="action-list">${subject.actions.map((action) => {
    const active = state.selection.kind === "action" && state.selection.actionId === action.actionId;
    const actionLabel = action.relation ? `${titleCase(action.relation)} navigation` : titleCase(action.actionKind);
    const resultLayerId = action.review?.kind === "reference"
      ? action.review?.reusedLayerId
      : action.review?.targetLayerId;
    return `<div class="action-result"><button class="action-chip ${active ? "active" : ""} ${action.reviewed ? "" : "missing"}" data-action-id="${escapeHtml(action.actionId)}" data-layer-id="${escapeHtml(subject.layerId)}" data-node-id="${escapeHtml(subject.nodeId)}"><span>${escapeHtml(actionLabel)} ${escapeHtml(action.actionId)}</span><b>${action.reviewed ? (Object.keys(action.review?.ratings || {}).length ? scoreLabel(action.review?.ratings) : titleCase(action.review.kind)) : "Not reviewed"}</b></button>${resultLayerId ? `<button class="result-link" data-result-layer="${escapeHtml(resultLayerId)}">${action.review.kind === "reference" ? "Open reused" : "Open child"} LayerResult ${escapeHtml(resultLayerId)}</button>` : action.review?.kind === "invoke" ? '<span class="null-result">Delivery null · recursion null</span>' : ""}</div>`;
  }).join("")}</div></section>`;
}

function semanticMarkup(subject) {
  const semantic = subject?.kind === "node" ? subject.review?.semantic : null;
  if (!semantic) return "";
  return `<section class="detail-section"><h3>Semantic compression</h3><dl class="semantic-summary"><div><dt>Meaning</dt><dd>${escapeHtml(semantic.meaning)}</dd></div><div><dt>Delivered</dt><dd>${escapeHtml(semantic.delivered)}</dd></div><div><dt>Limitations</dt><dd>${escapeHtml(semantic.limitations)}</dd></div><div><dt>Effect on layer</dt><dd>${escapeHtml(semantic.effectOnLayer)}</dd></div></dl></section>`;
}

function allocationMarkup(subject) {
  const steps = subject?.kind === "node" ? subject.review?.allocationSteps : null;
  if (!Array.isArray(steps)) return "";
  return `<section class="detail-section"><h3>Sequential action allocation</h3><div class="allocation-list">${steps.map((step) => `<article><header><b>Step ${escapeHtml(step.step)}</b><span>${escapeHtml(titleCase(step.authoredChoice))}${step.authoredActionId ? ` · ${escapeHtml(step.authoredActionId)}` : ""}</span><strong>${escapeHtml(titleCase(step.margin))}</strong></header><ol>${[...(step.ranking || [])].sort((left, right) => left.rank - right.rank).map((entry) => `<li><b>${escapeHtml(entry.rank)}</b> ${escapeHtml(titleCase(entry.choice))}</li>`).join("")}</ol><p>${escapeHtml(step.selectionFinding)}</p></article>`).join("")}</div></section>`;
}

function consumedRootMarkup(subject) {
  const root = subject?.kind === "turn" ? subject.review?.rootLayerResult : null;
  if (!root?.layerId) return "";
  return `<section class="detail-section"><h3>Consumed recursive result</h3><div class="consumed-root"><p><b>Root LayerResult ${escapeHtml(root.layerId)}</b><span>${escapeHtml(root.layerSummary || "Finalized semantic root")}</span></p><button class="result-link" data-result-layer="${escapeHtml(root.layerId)}">Open consumed root LayerResult</button></div></section>`;
}

function structureMarkup(subject) {
  if (subject?.kind !== "turn" || !subject.review?.structure) return "";
  const structure = subject.review.structure;
  return `<section class="detail-section"><h3>Structure judgment</h3>
    <dl class="ratings">
      <div><dt>Overall</dt><dd>${escapeHtml(titleCase(structure.overall))}</dd></div>
      <div><dt>Expansion</dt><dd>${escapeHtml(`${titleCase(structure.expansion?.need)} · ${titleCase(structure.expansion?.result)}`)}</dd></div>
      <div><dt>References</dt><dd>${escapeHtml(`${titleCase(structure.references?.need)} · ${titleCase(structure.references?.result)}`)}</dd></div>
    </dl><p class="review-summary">${escapeHtml(structure.reason)}</p></section>`;
}

function subjectTitle(subject) {
  if (subject?.kind === "action") return `${titleCase(subject.actionKind)} action ${subject.actionId}`;
  if (subject?.kind === "node") return `Node ${subject.nodeId}`;
  if (subject?.kind === "layer") return `Layer ${subject.layerId}`;
  return "Overall turn review";
}

function screenshotMarkup(screenshotId, autoLoad) {
  const saved = state.screenshots.get(screenshotId);
  if (saved?.error) return `<article class="evidence-card error"><div><b>${escapeHtml(screenshotId)}</b><span>Evidence unavailable</span></div><p>${escapeHtml(saved.error)}</p><button data-load-screenshot="${escapeHtml(screenshotId)}">Retry</button></article>`;
  if (!saved) return `<article class="evidence-card pending"><div><b>${escapeHtml(screenshotId)}</b><span>${state.pendingScreenshots.has(screenshotId) ? "Loading…" : "Screenshot evidence"}</span></div><button data-load-screenshot="${escapeHtml(screenshotId)}" ${state.pendingScreenshots.has(screenshotId) ? "disabled" : ""}>Load screenshot</button>${autoLoad ? '<span class="auto-load" aria-hidden="true"></span>' : ""}</article>`;
  const metadata = saved.metadata || {};
  const preview = saved.tiles?.[0]?.dataUrl;
  return `<button class="evidence-card loaded" data-open-screenshot="${escapeHtml(screenshotId)}">
    ${preview ? `<img src="${escapeHtml(preview)}" alt="${escapeHtml(metadata.label || `Screenshot ${screenshotId}`)}" />` : ""}
    <span class="evidence-copy"><b>${escapeHtml(metadata.label || screenshotId)}</b><small>${escapeHtml(metadata.mode || "capture")} · ${escapeHtml(saved.tiles?.length || 0)} tile${saved.tiles?.length === 1 ? "" : "s"}</small></span>
  </button>`;
}

function render() {
  const turn = state.analysis.turns[state.selectedTurn];
  if (!turn) {
    app.innerHTML = `<section class="loading-state"><span class="eyebrow">Judge review</span><h1>No turns are available.</h1><p>This execution has not produced a turn to review.</p></section>`;
    return;
  }
  const subject = subjectForSelection(turn, state.selection);
  const review = subject?.review ?? null;
  const subjectEvidence = subject?.evidenceIds ?? [];
  const evidenceIds = state.evidenceMode === "turn" ? turn.allEvidenceIds : subjectEvidence;
  const reviewed = subject?.reviewed !== false && Boolean(review);
  app.innerHTML = `
    <header class="topbar">
      <div class="brand"><span class="mark"></span><div><b>Judge review</b><small>${escapeHtml(state.analysis.judgeConfigurationName)}</small></div></div>
      <span class="execution-status ${escapeHtml(state.analysis.execution.status)}">${escapeHtml(state.analysis.execution.status)}</span>
    </header>
    <nav class="breadcrumb" aria-label="Judge review breadcrumb"><ol>${breadcrumbMarkup(turn, subject)}</ol></nav>
    <section class="turn-region"><div class="section-heading"><div><span class="eyebrow">Turn-by-turn analysis</span><h1>${escapeHtml(state.analysis.execution.testCaseId)}</h1></div>${statusMarkup(turn)}</div><div class="turn-rail">${state.analysis.turns.map(turnMarkup).join("")}</div></section>
    <section class="layer-region"><div class="section-heading"><div><span class="eyebrow">Recursive output</span><h2>Layers</h2></div>${coverageMarkup(turn.coverage)}</div>
      ${turn.layers.length ? `<div class="layer-rail">${turn.layers.map(layerMarkup).join("")}</div>` : `<div class="empty-surface"><b>No layer inventory</b><p>${escapeHtml(turn.stateReason || "This turn has no screenshot-backed layer review.")}</p></div>`}
    </section>
    <section class="analysis-grid">
      <article class="review-panel">
        <div class="review-heading"><div><span class="eyebrow">Selected ${escapeHtml(subject?.kind || "turn")}</span><h2>${escapeHtml(subjectTitle(subject))}</h2></div><span class="subject-score ${reviewed ? "" : "missing"}">${reviewed ? scoreLabel(review?.ratings) : "Not reviewed"}</span></div>
        ${turn.stateReason ? `<p class="state-reason">${escapeHtml(turn.stateReason)}</p>` : ""}
        <p class="review-summary">${escapeHtml(review?.summary || turn.result?.summary || "The judge did not submit a review for this subject.")}</p>
        <section class="detail-section"><h3>Criterion scores</h3>${ratingsMarkup(review)}</section>
        ${semanticMarkup(subject)}
        ${allocationMarkup(subject)}
        ${consumedRootMarkup(subject)}
        ${structureMarkup(subject)}
        ${actionsMarkup(subject)}
        <section class="detail-section"><h3>Findings</h3>${findingsMarkup(review)}</section>
      </article>
      <aside class="evidence-panel">
        <div class="evidence-heading"><div><span class="eyebrow">Visual proof</span><h2>Screenshot evidence</h2></div><div class="evidence-toggle" role="group" aria-label="Evidence scope"><button data-evidence-mode="subject" class="${state.evidenceMode === "subject" ? "active" : ""}">Selected subject</button><button data-evidence-mode="turn" class="${state.evidenceMode === "turn" ? "active" : ""}">All turn evidence</button></div></div>
        <p class="evidence-note">${state.evidenceMode === "subject" ? "Evidence cited by this review is loaded automatically." : "Turn evidence is listed without preloading every image. Load only the captures you need."}</p>
        <div class="evidence-gallery">${evidenceIds.length ? evidenceIds.map((screenshotId) => screenshotMarkup(screenshotId, state.evidenceMode === "subject")).join("") : '<div class="empty-surface"><b>No bound screenshots</b><p>This review subject has no screenshot evidence.</p></div>'}</div>
      </aside>
    </section>`;
  bindEvents();
  if (state.evidenceMode === "subject") void loadScreenshots(subjectEvidence);
}

function bindEvents() {
  document.querySelectorAll("[data-turn]").forEach((button) => {
    button.onclick = () => {
      state.selectedTurn = Number(button.dataset.turn);
      const turn = state.analysis.turns[state.selectedTurn];
      state.selection = turn.layers[0] ? { kind: "layer", layerId: turn.layers[0].layerId } : { kind: "turn" };
      state.evidenceMode = "subject";
      render();
    };
  });
  document.querySelectorAll("[data-layer-id].layer-heading").forEach((button) => {
    button.onclick = () => { state.selection = { kind: "layer", layerId: button.dataset.layerId }; state.evidenceMode = "subject"; render(); };
  });
  document.querySelectorAll("[data-node-id].node-chip").forEach((button) => {
    button.onclick = () => { state.selection = { kind: "node", layerId: button.dataset.layerId, nodeId: button.dataset.nodeId }; state.evidenceMode = "subject"; render(); };
  });
  document.querySelectorAll("[data-action-id]").forEach((button) => {
    button.onclick = () => { state.selection = { kind: "action", layerId: button.dataset.layerId, nodeId: button.dataset.nodeId, actionId: button.dataset.actionId }; state.evidenceMode = "subject"; render(); };
  });
  document.querySelectorAll("[data-result-layer]").forEach((button) => {
    button.onclick = () => { state.selection = { kind: "layer", layerId: button.dataset.resultLayer }; state.evidenceMode = "subject"; render(); };
  });
  document.querySelectorAll("[data-crumb-kind]").forEach((button) => {
    button.onclick = () => {
      state.selection = button.dataset.crumbKind === "turn" ? { kind: "turn" } : button.dataset.crumbKind === "layer"
        ? { kind: "layer", layerId: button.dataset.layerId }
        : { kind: "node", layerId: button.dataset.layerId, nodeId: button.dataset.nodeId };
      state.evidenceMode = "subject";
      render();
    };
  });
  document.querySelectorAll("[data-evidence-mode]").forEach((button) => {
    button.onclick = () => { state.evidenceMode = button.dataset.evidenceMode; render(); };
  });
  document.querySelectorAll("[data-load-screenshot]").forEach((button) => {
    button.onclick = () => void loadScreenshots([button.dataset.loadScreenshot]);
  });
  document.querySelectorAll("[data-open-screenshot]").forEach((button) => {
    button.onclick = () => openScreenshot(button.dataset.openScreenshot);
  });
}

async function loadScreenshots(screenshotIds) {
  const turn = state.analysis.turns[state.selectedTurn];
  if (!turn?.judgeResultId) return;
  const requested = screenshotIds.filter((screenshotId) => !state.screenshots.has(screenshotId) && !state.pendingScreenshots.has(screenshotId));
  if (!requested.length) return;
  requested.forEach((screenshotId) => state.pendingScreenshots.add(screenshotId));
  for (const screenshotId of requested) {
    try {
      const screenshot = await api.loadJudgeScreenshot({ executionId: state.analysis.execution.id, judgeResultId: turn.judgeResultId, screenshotId });
      state.screenshots.set(screenshotId, screenshot);
    } catch (error) {
      state.screenshots.set(screenshotId, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      state.pendingScreenshots.delete(screenshotId);
    }
  }
  render();
}

function openScreenshot(screenshotId) {
  const screenshot = state.screenshots.get(screenshotId);
  if (!screenshot || screenshot.error) return;
  dialogTitle.textContent = screenshot.metadata?.label || screenshotId;
  dialogBody.innerHTML = screenshot.tiles.map((tile, index) => `<img src="${escapeHtml(tile.dataUrl)}" alt="Screenshot tile ${index + 1} of ${screenshot.tiles.length}" />`).join("");
  dialog.showModal();
}

document.querySelector("#closeEvidence").onclick = () => dialog.close();
dialog.onclick = (event) => { if (event.target === dialog) dialog.close(); };

async function boot() {
  if (!api?.getRun || !api?.loadJudgeScreenshot) throw new Error("Judge review APIs are unavailable.");
  const params = new URLSearchParams(location.search);
  const runId = params.get("runId");
  const executionId = params.get("executionId");
  if (!runId || !executionId) throw new Error("Judge review requires runId and executionId.");
  state.analysis = buildJudgeAnalysis(await api.getRun(runId), executionId);
  const firstTurnWithLayers = state.analysis.turns.find((turn) => turn.layers.length) ?? state.analysis.turns[0];
  state.selectedTurn = firstTurnWithLayers?.position ?? 0;
  state.selection = firstTurnWithLayers?.layers[0]
    ? { kind: "layer", layerId: firstTurnWithLayers.layers[0].layerId }
    : { kind: "turn" };
  render();
}

void boot().catch((error) => {
  app.innerHTML = `<section class="loading-state error"><span class="eyebrow">Judge review unavailable</span><h1>Could not open this analysis.</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p></section>`;
});
