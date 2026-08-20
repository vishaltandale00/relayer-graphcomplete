import {
  availableModels,
  copySystemFamily,
  createModelFamilyDraft,
  defaultHarnessError,
  MAX_MODELS_PER_FAMILY,
  modelMember,
  moveItem,
  preserveFamilyEditAfterRefresh,
  replaceMemberProvider,
  validateCustomFamily,
} from "./model-family-model.js";
import {
  createModelFamily,
  deleteModelFamily,
  loadModelSettings,
  saveModelDefaults,
  saveModelFamilyOrder,
  updateModelFamily,
} from "./model-settings-api.js";
import {
  refreshNewThreadModelPicker,
  resetNewThreadModelPicker,
} from "./composer-model-picker.js";
import { appState } from "./state.js";
import { $, $$, escapeHtml, toast } from "./ui.js";

let settings = null;
let selectedFamilyIndex = 0;
let editSnapshot = null;
let draftSequence = 0;
let loading = false;
let savingFamily = false;

function provider(providerId) {
  return settings.providers.find((candidate) => candidate.id === providerId);
}

function providerModel(providerId, modelId) {
  return provider(providerId)?.models?.find((candidate) => candidate.id === modelId);
}

function hydrateMember(member) {
  const owner = provider(member.providerId) || { id: member.providerId, label: member.providerId };
  const model = providerModel(member.providerId, member.modelId) || {
    id: member.modelId,
    label: member.modelId,
    available: false,
    unavailableReason: "This model is no longer in the provider catalog.",
  };
  return modelMember(owner, model);
}

function normalizeSettings(response) {
  const next = {
    ...response,
    providers: response.providers ?? [],
    harnesses: response.harnesses ?? [],
    families: [...(response.families ?? [])].sort((left, right) => left.position - right.position),
  };
  appState.modelSettings = {
    ...next,
    defaults: { ...next.defaults },
    providers: next.providers.map((provider) => ({
      ...provider,
      models: (provider.models ?? []).map((model) => ({ ...model })),
    })),
    harnesses: next.harnesses.map((harness) => ({
      ...harness,
      compatibleProviderIds: [...(harness.compatibleProviderIds ?? [])],
    })),
    families: next.families.map((family) => ({
      ...family,
      members: (family.members ?? []).map((member) => ({ ...member })),
    })),
  };
  settings = next;
  settings.families = next.families.map((family) => ({
    ...family,
    models: [...(family.members ?? [])]
      .sort((left, right) => left.position - right.position)
      .map(hydrateMember),
  }));
  selectedFamilyIndex = Math.min(selectedFamilyIndex, Math.max(0, settings.families.length - 1));
}

function familyPayload(family) {
  return {
    name: family.name.trim(),
    enabled: family.enabled,
    members: family.models.map((member) => ({
      providerId: member.providerId,
      modelId: member.modelId,
    })),
  };
}

function nextAvailableMember(family, providerId = null, exceptIndex = -1) {
  const used = new Set(family.models
    .filter((_member, index) => index !== exceptIndex)
    .map((member) => `${member.providerId}\0${member.modelId}`));
  for (const owner of settings.providers) {
    if (providerId && owner.id !== providerId) continue;
    if (owner.connected === false) continue;
    const model = owner.models.find((candidate) => (
      candidate.visible !== false
      && candidate.available !== false
      && !used.has(`${owner.id}\0${candidate.id}`)
    ));
    if (model) return modelMember(owner, model);
  }
  return null;
}

function setStatus(message = "", kind = "") {
  const status = $("#modelSettingsStatus");
  status.textContent = message;
  status.className = `model-settings-status${kind ? ` ${kind}` : ""}`;
}

async function refresh({ preserveIndex = true, preserveEdit = false } = {}) {
  const previousIndex = selectedFamilyIndex;
  const previousFamilyId = settings?.families?.[previousIndex]?.id;
  const activeFamilies = preserveEdit
    ? settings?.families?.filter((family) => family.draft || family.editing).map((family) => structuredClone(family))
    : [];
  const previousEditSnapshot = editSnapshot;
  normalizeSettings(await loadModelSettings());
  const preserved = preserveFamilyEditAfterRefresh(settings.families, activeFamilies);
  settings.families = preserved.families;
  for (const index of preserved.preservedIndexes) {
    settings.families[index].models = settings.families[index].models
      .map((member) => hydrateMember({ providerId: member.providerId, modelId: member.modelId }));
  }
  const preservedVisibleIndex = settings.families.findIndex((family) => (
    String(family.id) === String(previousFamilyId)
  ));
  if (preserveIndex) {
    selectedFamilyIndex = preservedVisibleIndex >= 0
      ? preservedVisibleIndex
      : Math.min(previousIndex, settings.families.length - 1);
  }
  editSnapshot = activeFamilies.some((family) => family.editing)
    ? previousEditSnapshot ?? preserved.editSnapshot
    : null;
  render();
  refreshNewThreadModelPicker();
}

function harnessOptions() {
  const selectedConfigured = settings.harnesses.some((harness) => harness.id === settings.defaults.harnessId);
  const missing = selectedConfigured ? "" : `<option value="${escapeHtml(settings.defaults.harnessId)}" selected disabled>${escapeHtml(settings.defaults.harnessId)} (unavailable)</option>`;
  return `${missing}${settings.harnesses.map((harness) => {
    const selected = harness.id === settings.defaults.harnessId;
    return `<option value="${escapeHtml(harness.id)}" ${selected ? "selected" : ""} ${harness.available === false ? "disabled" : ""}>${escapeHtml(harness.label)}</option>`;
  }).join("")}`;
}

function providerOptions(selectedProviderId) {
  return settings.providers.map((item) => {
    const selected = item.id === selectedProviderId;
    const unavailable = item.connected === false;
    return `<option value="${escapeHtml(item.id)}" ${selected ? "selected" : ""} ${unavailable ? "disabled" : ""}>${escapeHtml(item.label)}</option>`;
  }).join("");
}

function defaultProviderOptions() {
  return providerOptions(settings.defaults.providerId);
}

function unavailableModelOption(member) {
  if (providerModel(member.providerId, member.modelId)) return "";
  return `<option value="${escapeHtml(member.modelId)}" selected disabled>${escapeHtml(member.modelLabel)}</option>`;
}

function modelOptions(member) {
  const owner = provider(member.providerId);
  return `${unavailableModelOption(member)}${availableModels(settings.providers, member.providerId).filter((model) => (
    model.visible !== false || model.id === member.modelId
  )).map((model) => {
    const selected = model.id === member.modelId;
    const unavailable = owner?.connected === false || model.visible === false || model.available === false;
    return `<option value="${escapeHtml(model.id)}" ${selected ? "selected" : ""} ${unavailable ? "disabled" : ""}>${escapeHtml(model.label)}</option>`;
  }).join("")}`;
}

function familyList() {
  return settings.families.map((family, index) => `
    <button type="button" role="option" aria-selected="${index === selectedFamilyIndex}" data-family-jump="${index}">
      <span>${escapeHtml(family.name || "New family")}</span>
      ${family.enabled ? "" : "<i>Hidden</i>"}
    </button>`).join("");
}

function memberReadOnly(member, index) {
  const unavailable = member.available === false;
  return `<li class="family-member${unavailable ? " unavailable" : ""}">
    <span class="member-order">${index + 1}</span>
    <span class="member-provider">${escapeHtml(member.providerLabel)}</span>
    <strong>${escapeHtml(member.modelLabel)}</strong>
    ${unavailable ? `<span class="member-error">${escapeHtml(member.unavailableReason || "Unavailable")}</span>` : ""}
  </li>`;
}

function memberEditor(member, index, count) {
  const reason = member.available === false ? member.unavailableReason : null;
  return `<li class="family-member-editor${reason ? " unavailable" : ""}" data-member-index="${index}">
    <span class="member-order">${index + 1}</span>
    <select aria-label="Provider for model ${index + 1}" data-member-provider="${index}" ${savingFamily ? "disabled" : ""}>${providerOptions(member.providerId)}</select>
    <select aria-label="Model ${index + 1}" data-member-model="${index}" ${savingFamily ? "disabled" : ""}>${modelOptions(member)}</select>
    <span class="member-actions">
      <button type="button" class="icon-button" data-member-up="${index}" title="Move up" aria-label="Move model ${index + 1} up" ${savingFamily || index === 0 ? "disabled" : ""}>↑</button>
      <button type="button" class="icon-button" data-member-down="${index}" title="Move down" aria-label="Move model ${index + 1} down" ${savingFamily || index === count - 1 ? "disabled" : ""}>↓</button>
      <button type="button" class="icon-button" data-member-remove="${index}" title="Remove" aria-label="Remove model ${index + 1}" ${savingFamily ? "disabled" : ""}>×</button>
    </span>
    ${reason ? `<span class="member-error">${escapeHtml(reason)}</span>` : ""}
  </li>`;
}

function familyEditor(family) {
  const errors = family.validationErrors ?? {};
  return `<article class="family-card family-editor-card" aria-busy="${savingFamily}">
    <div class="family-card-heading">
      <label class="family-name-field"><span>Name</span><input id="familyNameInput" placeholder="Family name" aria-invalid="${Boolean(errors.name)}" ${savingFamily ? "disabled" : ""} /></label>
      <span class="family-kind">Custom</span>
    </div>
    ${errors.name ? `<div class="field-error">${escapeHtml(errors.name)}</div>` : ""}
    <ol class="family-members family-member-editors">${family.models.map((member, index) => memberEditor(member, index, family.models.length)).join("")}</ol>
    ${errors.models ? `<div class="field-error">${escapeHtml(errors.models)}</div>` : ""}
    <div class="family-editor-actions">
      <button type="button" class="secondary" id="addFamilyModel" ${savingFamily || family.models.length >= MAX_MODELS_PER_FAMILY || !nextAvailableMember(family) ? "disabled" : ""}>＋ Add model</button>
      <span class="push"></span>
      <button type="button" class="secondary" id="cancelFamilyEdit" ${savingFamily ? "disabled" : ""}>Cancel</button>
      <button type="button" class="primary" id="saveFamilyEdit" ${savingFamily ? "disabled" : ""}>Save</button>
    </div>
  </article>`;
}

function familySlide(family, index) {
  if (family.draft || family.editing) return `<div class="family-slide" data-family-slide="${index}">${familyEditor(family)}</div>`;
  const system = family.kind === "system";
  return `<div class="family-slide" data-family-slide="${index}">
    <article class="family-card">
      <div class="family-card-heading">
        <div><h3>${escapeHtml(family.name)}</h3><span class="family-kind">${system ? "System" : "Custom"}</span></div>
        <label class="family-enabled"><input type="checkbox" data-family-enabled="${index}" ${family.enabled ? "checked" : ""} /><span>Enabled</span></label>
      </div>
      <ol class="family-members">${family.models.map(memberReadOnly).join("")}</ol>
      <div class="family-card-actions">
        <button type="button" class="secondary" data-family-left="${index}" ${index === 0 ? "disabled" : ""}>← Move</button>
        <button type="button" class="secondary" data-family-right="${index}" ${index === settings.families.length - 1 ? "disabled" : ""}>Move →</button>
        <span class="push"></span>
        ${system
          ? `<button type="button" class="secondary" data-family-copy="${index}">Copy</button>`
          : `<button type="button" class="secondary" data-family-delete="${index}">Delete</button>
             <button type="button" class="secondary" data-family-edit="${index}">Edit</button>`}
      </div>
    </article>
  </div>`;
}

function render() {
  if (!settings) return;
  $("#defaultHarnessSelect").innerHTML = harnessOptions();
  $("#defaultProviderSelect").innerHTML = defaultProviderOptions();
  const harnessError = defaultHarnessError(settings);
  $("#defaultHarnessError").textContent = harnessError ?? "";
  $("#defaultHarnessError").classList.toggle("hidden", !harnessError);

  const count = settings.families.length;
  const current = settings.families[selectedFamilyIndex];
  $("#currentFamilyName").textContent = current ? (current.name || "New family") : "No model families";
  $("#familyPosition").textContent = count ? `${selectedFamilyIndex + 1} / ${count}` : "0 / 0";
  $("#previousFamily").disabled = selectedFamilyIndex <= 0;
  $("#nextFamily").disabled = selectedFamilyIndex >= count - 1;
  $("#familyJumpList").innerHTML = familyList();
  $("#familyCarousel").innerHTML = count
    ? settings.families.map(familySlide).join("")
    : `<div class="family-slide"><div class="family-empty">Create your first model family.</div></div>`;
  if (current?.draft || current?.editing) $("#familyNameInput").value = current.name;
  bindRenderedEvents();
  requestAnimationFrame(() => {
    const viewport = $("#familyCarousel");
    viewport.scrollTo({ left: selectedFamilyIndex * viewport.clientWidth, behavior: "auto" });
  });
}

function chooseFamily(index, behavior = "smooth") {
  if (!settings.families[index]) return;
  selectedFamilyIndex = index;
  render();
  requestAnimationFrame(() => {
    const viewport = $("#familyCarousel");
    viewport.scrollTo({ left: index * viewport.clientWidth, behavior });
  });
}

function updateCurrentFamily(mutator) {
  const family = settings.families[selectedFamilyIndex];
  mutator(family);
  family.validationErrors = {};
  render();
}

async function persistFamilyOrder(fromIndex, toIndex) {
  const previous = settings.families;
  settings.families = moveItem(settings.families, fromIndex, toIndex);
  selectedFamilyIndex = toIndex;
  render();
  try {
    await saveModelFamilyOrder(settings.families.filter((family) => !family.draft).map((family) => family.id));
    await refresh({ preserveEdit: true });
  } catch (error) {
    settings.families = previous;
    selectedFamilyIndex = fromIndex;
    render();
    toast(error.message);
  }
}

async function persistEnabled(index, enabled) {
  const family = settings.families[index];
  family.enabled = enabled;
  try {
    await updateModelFamily(family.id, family.kind === "system" ? { enabled } : familyPayload(family));
    await refresh({ preserveEdit: true });
  } catch (error) {
    family.enabled = !enabled;
    render();
    toast(error.message);
  }
}

function beginNewFamily(seed = null) {
  if (settings.families.some((family) => family.draft || family.editing)) return;
  const family = seed || createModelFamilyDraft(
    settings.providers,
    ++draftSequence,
    settings.defaults.providerId,
  );
  settings.families.push(family);
  editSnapshot = null;
  chooseFamily(settings.families.length - 1);
  requestAnimationFrame(() => $("#familyNameInput")?.focus());
}

function beginEdit(index) {
  if (settings.families.some((family) => family.draft || family.editing)) return;
  const family = settings.families[index];
  editSnapshot = structuredClone(family);
  family.editing = true;
  chooseFamily(index, "instant");
  requestAnimationFrame(() => $("#familyNameInput")?.focus());
}

function cancelEdit() {
  const family = settings.families[selectedFamilyIndex];
  if (family.draft) settings.families.splice(selectedFamilyIndex, 1);
  else if (editSnapshot) settings.families[selectedFamilyIndex] = editSnapshot;
  editSnapshot = null;
  selectedFamilyIndex = Math.max(0, Math.min(selectedFamilyIndex, settings.families.length - 1));
  render();
}

async function saveEdit() {
  if (savingFamily) return;
  const family = settings.families[selectedFamilyIndex];
  family.name = $("#familyNameInput").value;
  family.validationErrors = validateCustomFamily(family, settings.families);
  if (Object.keys(family.validationErrors).length) return render();
  savingFamily = true;
  render();
  try {
    if (family.draft) await createModelFamily(familyPayload(family));
    else await updateModelFamily(family.id, familyPayload(family));
    await refresh();
    setStatus("Saved", "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    savingFamily = false;
    render();
  }
}

async function deleteFamily(index) {
  const family = settings.families[index];
  if (!family || family.kind === "system" || family.draft) return;
  if (!window.confirm(`Delete “${family.name}”?`)) return;
  try {
    await deleteModelFamily(family.id);
    selectedFamilyIndex = Math.min(index, Math.max(0, settings.families.length - 2));
    await refresh({ preserveEdit: true });
    setStatus("Deleted", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function bindEditorEvents(family) {
  $("#familyNameInput").oninput = (event) => { family.name = event.target.value; };
  $("#familyNameInput").onkeydown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveEdit();
    }
  };
  $("#cancelFamilyEdit").onclick = cancelEdit;
  $("#saveFamilyEdit").onclick = saveEdit;
  $("#addFamilyModel").onclick = () => updateCurrentFamily((current) => {
    const member = nextAvailableMember(current);
    if (member && current.models.length < MAX_MODELS_PER_FAMILY) current.models.push(member);
  });
  $$('[data-member-provider]').forEach((select) => {
    select.onchange = () => updateCurrentFamily((current) => {
      const index = Number(select.dataset.memberProvider);
      const owner = provider(select.value);
      const replacement = nextAvailableMember(current, owner.id, index);
      current.models[index] = replacement
        ?? replaceMemberProvider(current.models[index], owner, null);
    });
  });
  $$('[data-member-model]').forEach((select) => {
    select.onchange = () => updateCurrentFamily((current) => {
      const index = Number(select.dataset.memberModel);
      current.models[index] = modelMember(provider(current.models[index].providerId), providerModel(current.models[index].providerId, select.value));
    });
  });
  $$('[data-member-up]').forEach((button) => {
    button.onclick = () => updateCurrentFamily((current) => {
      const index = Number(button.dataset.memberUp);
      current.models = moveItem(current.models, index, index - 1);
    });
  });
  $$('[data-member-down]').forEach((button) => {
    button.onclick = () => updateCurrentFamily((current) => {
      const index = Number(button.dataset.memberDown);
      current.models = moveItem(current.models, index, index + 1);
    });
  });
  $$('[data-member-remove]').forEach((button) => {
    button.onclick = () => updateCurrentFamily((current) => current.models.splice(Number(button.dataset.memberRemove), 1));
  });
}

function bindRenderedEvents() {
  $$('[data-family-jump]').forEach((button) => {
    button.onclick = () => chooseFamily(Number(button.dataset.familyJump));
  });
  $$('[data-family-enabled]').forEach((input) => {
    input.onchange = () => void persistEnabled(Number(input.dataset.familyEnabled), input.checked);
  });
  $$('[data-family-left]').forEach((button) => {
    button.onclick = () => void persistFamilyOrder(Number(button.dataset.familyLeft), Number(button.dataset.familyLeft) - 1);
  });
  $$('[data-family-right]').forEach((button) => {
    button.onclick = () => void persistFamilyOrder(Number(button.dataset.familyRight), Number(button.dataset.familyRight) + 1);
  });
  $$('[data-family-copy]').forEach((button) => {
    button.onclick = () => beginNewFamily(copySystemFamily(settings.families[Number(button.dataset.familyCopy)], ++draftSequence));
  });
  $$('[data-family-edit]').forEach((button) => {
    button.onclick = () => beginEdit(Number(button.dataset.familyEdit));
  });
  $$('[data-family-delete]').forEach((button) => {
    button.onclick = () => void deleteFamily(Number(button.dataset.familyDelete));
  });
  const current = settings.families[selectedFamilyIndex];
  if (current?.draft || current?.editing) bindEditorEvents(current);
}

async function persistDefault(field) {
  const previous = { ...settings.defaults };
  settings.defaults[field] = field === "harnessId"
    ? $("#defaultHarnessSelect").value
    : $("#defaultProviderSelect").value;
  render();
  try {
    await saveModelDefaults({ [field]: settings.defaults[field] });
    await refresh({ preserveEdit: true });
    if (field === "harnessId") resetNewThreadModelPicker();
    setStatus("Saved", "success");
  } catch (error) {
    settings.defaults = previous;
    render();
    setStatus(error.message, "error");
  }
}

function bindStaticEvents() {
  $("#defaultHarnessSelect").onchange = () => persistDefault("harnessId");
  $("#defaultProviderSelect").onchange = () => persistDefault("providerId");
  $("#previousFamily").onclick = () => chooseFamily(selectedFamilyIndex - 1);
  $("#nextFamily").onclick = () => chooseFamily(selectedFamilyIndex + 1);
  $("#newModelFamily").onclick = () => beginNewFamily();
  const familyControl = $(".current-family-control");
  const familyButton = $(".current-family-button");
  familyControl.onmouseenter = () => familyButton.setAttribute("aria-expanded", "true");
  familyControl.onmouseleave = () => familyButton.setAttribute("aria-expanded", "false");
  familyControl.onfocusin = () => familyButton.setAttribute("aria-expanded", "true");
  familyControl.onfocusout = () => requestAnimationFrame(() => {
    familyButton.setAttribute("aria-expanded", String(familyControl.contains(document.activeElement)));
  });
  $("#familyCarousel").addEventListener("scrollend", (event) => {
    if (!settings || event.target.clientWidth === 0) return;
    const index = Math.round(event.target.scrollLeft / event.target.clientWidth);
    if (index === selectedFamilyIndex || !settings.families[index]) return;
    selectedFamilyIndex = index;
    $("#currentFamilyName").textContent = settings.families[index].name;
    $("#familyPosition").textContent = `${index + 1} / ${settings.families.length}`;
    $("#previousFamily").disabled = index === 0;
    $("#nextFamily").disabled = index === settings.families.length - 1;
    $$('[data-family-jump]').forEach((button) => button.setAttribute("aria-selected", String(Number(button.dataset.familyJump) === index)));
  });
}

export async function initializeModelFamilySettings() {
  if (loading || settings) return;
  loading = true;
  bindStaticEvents();
  try {
    normalizeSettings(await loadModelSettings());
    render();
  } catch (error) {
    setStatus(error.message, "error");
    $("#modelFamilyLoading").textContent = "Model settings unavailable.";
  } finally {
    loading = false;
  }
}

export async function refreshModelFamilySettings() {
  if (!settings) return initializeModelFamilySettings();
  return refresh({ preserveEdit: true });
}
