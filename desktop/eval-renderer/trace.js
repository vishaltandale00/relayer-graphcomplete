const api = window.relayerEvalTrace;
const params = new URLSearchParams(location.search);
const executionId = params.get("executionId");
let selectedInteractionId = params.get("interactionId");
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);

async function render(interactionId) {
  const trace = await api.load(executionId, interactionId || undefined);
  selectedInteractionId = String(trace.turn.interactionId);
  document.querySelector("#harness").textContent = trace.execution.harnessConfigurationName;
  document.querySelector("#case").textContent = trace.execution.testCaseId;
  document.querySelector("#prompt").textContent = trace.turn.prompt;
  document.querySelector("#status").textContent = `${trace.turn.candidateTrace.status} · turn ${(trace.turn.turnIndex ?? 0) + 1}`;
  document.querySelector("#turns").innerHTML = trace.execution.turns.map((turn) => `<button class="${String(turn.interactionId) === selectedInteractionId ? "active" : ""}" data-turn="${escapeHtml(turn.interactionId)}">Turn ${(turn.turnIndex ?? 0) + 1}<br><small>${escapeHtml(turn.candidateTrace?.status || "missing")}</small></button>`).join("");
  document.querySelectorAll("[data-turn]").forEach((button) => { button.onclick = () => render(button.dataset.turn); });
  const coverage = trace.manifest?.achievedCoverage || trace.turn.candidateTrace.coverage || {};
  document.querySelector("#coverage").innerHTML = Object.entries(coverage).map(([name, value]) => `<span>${escapeHtml(name)}: ${escapeHtml(value)}</span>`).join("");
  document.querySelector("#summary").textContent = trace.manifest ? `${trace.events.length} events · ${trace.turn.candidateTrace.byteLength || 0} bytes · ${trace.turn.candidateTrace.sha256 || "no digest"}` : trace.turn.candidateTrace.error || "No trace artifact was captured.";
  document.querySelector("#events").innerHTML = trace.events.length ? trace.events.map((event) => `<article class="event"><code>#${escapeHtml(event.sequence)}</code><b>${escapeHtml(event.type)}</b><pre>${escapeHtml(JSON.stringify(event.data, null, 2))}</pre></article>`).join("") : '<div class="empty">No events are available for this turn.</div>';
}

void render(selectedInteractionId).catch((error) => {
  document.querySelector("#events").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
});
