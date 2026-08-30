function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
})[character]);
const jsonText = (value) => JSON.stringify(value, null, 2) ?? "null";

function taggedParameters(value) {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, parameter]) => ({
      name,
      type: isRecord(parameter) && typeof parameter.type === "string" ? parameter.type : "unknown",
      value: isRecord(parameter) && Object.hasOwn(parameter, "value") ? parameter.value : null,
    }));
}

function operationViewModel(operation) {
  const search = operation?.path === "/api/graph/search" ? {
    queryContractVersion: Number.isSafeInteger(operation.queryContractVersion)
      ? operation.queryContractVersion
      : null,
    query: typeof operation.query === "string" ? operation.query : "",
    parameters: taggedParameters(operation.parameters),
    budget: isRecord(operation.budget) ? operation.budget : {},
    returnedLayerIds: Array.isArray(operation.searchLayerIds)
      ? operation.searchLayerIds.filter((id) => Number.isSafeInteger(id) && id > 0)
      : [],
    responseOrderSequence: Number.isSafeInteger(operation.sequence) ? operation.sequence : null,
  } : undefined;
  return {
    sequence: Number.isSafeInteger(operation?.sequence) ? operation.sequence : null,
    method: typeof operation?.method === "string" ? operation.method : "",
    path: typeof operation?.path === "string" ? operation.path : "",
    status: Number.isSafeInteger(operation?.status) ? operation.status : null,
    errorCodes: Array.isArray(operation?.errorCodes)
      ? operation.errorCodes.filter((code) => typeof code === "string")
      : [],
    ...(search === undefined ? {} : { search }),
  };
}

export function buildGraphOperationsViewModel(trace) {
  const evidence = isRecord(trace?.graphOperationsEvidence)
    ? trace.graphOperationsEvidence
    : { status: "unavailable", error: "Graph-operation evidence status is unavailable." };
  const operations = Array.isArray(trace?.graphOperations)
    ? trace.graphOperations.map(operationViewModel)
    : [];
  return {
    status: typeof evidence.status === "string" ? evidence.status : "unavailable",
    error: typeof evidence.error === "string" ? evidence.error : null,
    operationCount: operations.length,
    operations,
  };
}

function taggedParametersMarkup(parameters) {
  if (parameters.length === 0) return '<span class="muted">none</span>';
  return `<ul class="tagged-parameters">${parameters.map((parameter) => `<li><code>$${escapeHtml(parameter.name)}</code><span class="type-tag">${escapeHtml(parameter.type)}</span><code>${escapeHtml(jsonText(parameter.value))}</code></li>`).join("")}</ul>`;
}

function searchEvidenceMarkup(search) {
  const returnedLayers = search.returnedLayerIds.length === 0
    ? '<span class="muted">none</span>'
    : search.returnedLayerIds.map((id) => `<span class="layer-id">layer:${escapeHtml(id)}</span>`).join("");
  return `<div class="search-evidence">
    <dl>
      <div><dt>Query contract version</dt><dd>${search.queryContractVersion === null ? "not recorded" : escapeHtml(search.queryContractVersion)}</dd></div>
      <div><dt>Response-order sequence</dt><dd>#${search.responseOrderSequence === null ? "not recorded" : escapeHtml(search.responseOrderSequence)}</dd></div>
      <div class="wide"><dt>Query text</dt><dd><pre>${escapeHtml(search.query || "not recorded")}</pre></dd></div>
      <div class="wide"><dt>Tagged parameters</dt><dd>${taggedParametersMarkup(search.parameters)}</dd></div>
      <div class="wide"><dt>Budget</dt><dd><pre>${escapeHtml(jsonText(search.budget))}</pre></dd></div>
      <div class="wide"><dt>Returned layer IDs</dt><dd class="layer-ids">${returnedLayers}</dd></div>
    </dl>
  </div>`;
}

function operationMarkup(operation) {
  const errors = operation.errorCodes.length === 0 ? "none" : operation.errorCodes.join(", ");
  return `<article class="graph-operation">
    <div class="operation-heading">
      <code>#${operation.sequence === null ? "?" : escapeHtml(operation.sequence)}</code>
      <b>${escapeHtml(operation.method)} ${escapeHtml(operation.path)}</b>
      <span class="response-status">HTTP ${operation.status === null ? "?" : escapeHtml(operation.status)}</span>
    </div>
    <div class="error-codes"><span>Error codes</span><code>${escapeHtml(errors)}</code></div>
    ${operation.search === undefined ? "" : searchEvidenceMarkup(operation.search)}
  </article>`;
}

export function renderGraphOperationsMarkup(model) {
  return model.operations.length > 0
    ? model.operations.map(operationMarkup).join("")
    : `<div class="empty">${escapeHtml(model.error || "No graph operations were recorded for this turn.")}</div>`;
}
