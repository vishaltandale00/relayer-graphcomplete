import { escapeHtmlAttribute } from "./ui.js";
import { providerModelsNewestFirst } from "./provider-model-order.js";

export { providerModelsNewestFirst } from "./provider-model-order.js";

const modelIdentity = (model) => String(model.modelId ?? model.id ?? "");

export function providerModelOptionsMarkup(models, { query = "", selectedId = null } = {}) {
  const selected = (models ?? []).find((model) => modelIdentity(model) === String(selectedId));
  const visible = providerModelsNewestFirst(models, query);
  if (selected && !visible.includes(selected)) visible.push(selected);
  return visible.map((model) => {
    const id = modelIdentity(model);
    const unavailable = model.visible === false || model.available === false;
    return `<option value="${escapeHtmlAttribute(id)}" ${id === String(selectedId) ? "selected" : ""} ${unavailable ? "disabled" : ""}>${escapeHtmlAttribute(model.label ?? id)}</option>`;
  }).join("");
}

export function providerModelSearchMarkup({ query = "", inputAttribute, clearAttribute, label = "Search models", controlsId } = {}) {
  return `<div class="provider-model-search-control" role="search">
    <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m14.2 13.1 3.35 3.35-1.1 1.1-3.35-3.35a6.5 6.5 0 1 1 1.1-1.1ZM8.5 13.5a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" /></svg>
    <input type="search" aria-label="${escapeHtmlAttribute(label)}" aria-controls="${escapeHtmlAttribute(controlsId)}" autocomplete="off" placeholder="${escapeHtmlAttribute(label)}" value="${escapeHtmlAttribute(query)}" ${inputAttribute} />
    <button type="button" class="provider-model-search-clear" aria-label="Clear model search" ${clearAttribute} ${query ? "" : "hidden"}>×</button>
  </div>`;
}

export function providerModelOptionButtonsMarkup(models, { query = "", selectedId = null, index = 0, disabled = false } = {}) {
  const selected = (models ?? []).find((model) => modelIdentity(model) === String(selectedId));
  const visible = providerModelsNewestFirst(models, query);
  if (selected && !visible.includes(selected)) visible.push(selected);
  return visible.map((model) => {
    const id = modelIdentity(model);
    const unavailable = model.visible === false || model.available === false;
    const current = id === String(selectedId);
    return `<button type="button" class="provider-model-option" aria-pressed="${current}" data-selected="${current}" data-member-model-index="${index}" data-member-model-option="${escapeHtmlAttribute(id)}" ${unavailable || disabled ? "disabled" : ""}><span>${escapeHtmlAttribute(model.label ?? id)}</span><small>${escapeHtmlAttribute(id)}</small>${current ? '<i aria-hidden="true">✓</i>' : ""}</button>`;
  }).join("") || '<p class="provider-model-search-empty">No matching models.</p>';
}

export function providerModelComboboxMarkup(models, {
  query = "", selectedId = null, selectedLabel = null, index = 0, providerId = "", providerLabel = "Provider", disabled = false,
} = {}) {
  const selected = (models ?? []).find((model) => modelIdentity(model) === String(selectedId));
  const label = selected?.label ?? selectedLabel ?? selectedId ?? "Choose a model";
  const listId = `member-model-options-${index}`;
  return `<details class="provider-model-combobox" data-member-model-combobox="${index}" data-disabled="${disabled}">
    <summary aria-label="Model ${index + 1}: ${escapeHtmlAttribute(label)}" ${disabled ? 'aria-disabled="true" tabindex="-1"' : ""}><span>${escapeHtmlAttribute(label)}</span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 7.5 4.5 4.5 4.5-4.5" /></svg></summary>
    <div class="provider-model-combobox-panel">
      ${providerModelSearchMarkup({ query, controlsId: listId, label: `Search ${providerLabel} models`, inputAttribute: `data-member-model-search="${index}" data-member-model-provider="${escapeHtmlAttribute(providerId)}"`, clearAttribute: `data-member-model-search-clear="${index}" data-member-model-provider="${escapeHtmlAttribute(providerId)}"` })}
      <div class="provider-model-options" id="${listId}" role="group" aria-label="${escapeHtmlAttribute(providerLabel)} models" data-member-model-options="${index}">${providerModelOptionButtonsMarkup(models, { query, selectedId, index, disabled })}</div>
    </div>
  </details>`;
}
