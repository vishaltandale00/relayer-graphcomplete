import {
  availableModels,
  copySystemFamily,
  createFamilyVisibilityGate,
  createModelFamilyDraft,
  defaultHarnessChangeNotice,
  defaultHarnessIsSelectable,
  defaultHarnessError,
  defaultFamilyRecoveryPresentation,
  defaultProviderChoices,
  defaultProviderHint,
  MAX_MODELS_PER_FAMILY,
  modelMember,
  moveItem,
  preserveFamilyEditAfterRefresh,
  reconcileSavedFamily,
  replaceMemberProvider,
  usableDefaultHarnesses,
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
import { preparePermissionProfiles } from "./permission-profiles.js";
import { providerModelsRefreshAction, refreshProviderModels } from "./provider-models-refresh.js";
import { appState } from "./state.js";
import { createLatestRequestGate } from "./navigation-history.js";
import { $, $$, escapeHtml, escapeHtmlAttribute, toast } from "./ui.js";
import { renderHarnessSettings } from "./harness-settings.js";

let settings = null;
let selectedFamilyIndex = 0;
let editSnapshot = null;
let draftSequence = 0;
let loading = false;
let savingFamily = false;
let savingOrder = false;
let savingDefaults = false;
let refreshingDefaultFamily = false;
const familyVisibilityGate = createFamilyVisibilityGate();
const settingsRefreshGate = createLatestRequestGate();

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
  return { ...modelMember(owner, model), roles: structuredClone(member.roles ?? []) };
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
  renderHarnessSettings(appState.modelSettings);
}

function familyPayload(family) {
  return {
    name: family.name.trim(),
    enabled: family.enabled,
    members: family.models.map((member) => ({
      providerId: member.providerId,
      modelId: member.modelId,
      roles: structuredClone(member.roles ?? []),
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

export async function refreshModelSettings({ preserveIndex = true, preserveEdit = false } = {}) {
  const refreshToken = settingsRefreshGate.begin();
  let response;
  try {
    response = await loadModelSettings();
  } catch (error) {
    if (!settingsRefreshGate.isCurrent(refreshToken)) return false;
    throw error;
  }
  if (!settingsRefreshGate.isCurrent(refreshToken)) return false;
  // Edits may start, change, or be cancelled while discovery is in flight.
  // Preserve the current editor, not the state from when the request began.
  const previousIndex = selectedFamilyIndex;
  const previousFamilyId = settings?.families?.[previousIndex]?.id;
  const activeFamilies = preserveEdit
    ? settings?.families?.filter((family) => family.draft || family.editing).map((family) => structuredClone(family))
    : [];
  const previousEditSnapshot = editSnapshot;
  normalizeSettings(response);
  const preserved = preserveFamilyEditAfterRefresh(settings.families, activeFamilies);
  settings.families = preserved.families;
  for (const index of preserved.preservedIndexes) {
    settings.families[index].models = settings.families[index].models
      .map((member) => hydrateMember(member));
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
  return true;
}

function harnessOptions(recovery) {
  const selectable = usableDefaultHarnesses(settings);
  const selected = settings.harnesses.find((harness) => harness.id === settings.defaults.harnessId);
  // While the default family needs model setup, the server refuses a harness change, so the
  // saved harness is shown as it is rather than as unavailable.
  if (recovery && recovery.action !== "families") {
    return `<option value="${escapeHtmlAttribute(settings.defaults.harnessId)}" selected>${escapeHtml(selected?.label ?? settings.defaults.harnessId)}</option>`;
  }
  const invalidDefault = defaultHarnessIsSelectable(settings, settings.defaults.harnessId)
    ? ""
    : `<option value="${escapeHtmlAttribute(settings.defaults.harnessId)}" selected disabled>${escapeHtml(selected?.label ?? settings.defaults.harnessId)} (unavailable)</option>`;
  return `${invalidDefault}${selectable.map((harness) => {
    const selected = harness.id === settings.defaults.harnessId;
    return `<option value="${escapeHtmlAttribute(harness.id)}" ${selected ? "selected" : ""}>${escapeHtml(harness.label)}</option>`;
  }).join("")}`;
}

function providerOptions(selectedProviderId) {
  return settings.providers.map((item) => {
    const selected = item.id === selectedProviderId;
    const unavailable = item.connected === false;
    return `<option value="${escapeHtmlAttribute(item.id)}" ${selected ? "selected" : ""} ${unavailable ? "disabled" : ""}>${escapeHtml(item.label)}</option>`;
  }).join("");
}

function defaultProviderOptions() {
  const { selectable } = defaultProviderChoices(settings);
  const current = settings.providers.find((item) => item.id === settings.defaults.providerId);
  // The saved default stays visible. It is marked unavailable only when it is not connected.
  const currentLabel = current?.connected === false || !current
    ? `${current?.label ?? settings.defaults.providerId} (unavailable)`
    : current.label;
  const stranded = selectable.some((item) => item.id === settings.defaults.providerId)
    ? ""
    : `<option value="${escapeHtmlAttribute(settings.defaults.providerId)}" selected disabled>${escapeHtml(currentLabel)}</option>`;
  return `${stranded}${selectable.map((item) => {
    const selected = item.id === settings.defaults.providerId;
    return `<option value="${escapeHtmlAttribute(item.id)}" ${selected ? "selected" : ""}>${escapeHtml(item.label)}</option>`;
  }).join("")}`;
}

function unavailableModelOption(member) {
  if (providerModel(member.providerId, member.modelId)) return "";
  return `<option value="${escapeHtmlAttribute(member.modelId)}" selected disabled>${escapeHtml(member.modelLabel)}</option>`;
}

function modelOptions(member) {
  const owner = provider(member.providerId);
  return `${unavailableModelOption(member)}${availableModels(settings.providers, member.providerId).filter((model) => (
    model.visible !== false || model.id === member.modelId
  )).map((model) => {
    const selected = model.id === member.modelId;
    const unavailable = owner?.connected === false || model.visible === false || model.available === false;
    return `<option value="${escapeHtmlAttribute(model.id)}" ${selected ? "selected" : ""} ${unavailable ? "disabled" : ""}>${escapeHtml(model.label)}</option>`;
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
    <span class="member-roles">${(member.roles ?? []).map((role) => `<span title="${escapeHtmlAttribute(role.description ?? "")}">${escapeHtml(role.name)}</span>`).join(" · ")}</span>
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
    <div class="member-role-editor">
      <label><input type="radio" name="family-orchestrator" data-member-orchestrator="${index}" ${member.roles?.some((role) => role.name === "orchestrator") ? "checked" : ""} ${savingFamily ? "disabled" : ""} /> Orchestrator</label>
      ${(member.roles ?? []).map((role, roleIndex) => role.name === "orchestrator" ? "" : `<div class="member-specialist-role"><input aria-label="Specialist role for model ${index + 1}" data-role-name="${index}:${roleIndex}" maxlength="80" value="${escapeHtmlAttribute(role.name)}" ${savingFamily ? "disabled" : ""} /><input aria-label="Role description for model ${index + 1}" data-role-description="${index}:${roleIndex}" maxlength="240" placeholder="Short description (optional)" value="${escapeHtmlAttribute(role.description ?? "")}" ${savingFamily ? "disabled" : ""} /><button type="button" data-role-remove="${index}:${roleIndex}" aria-label="Remove specialist role" ${savingFamily ? "disabled" : ""}>×</button></div>`).join("")}
      <button type="button" class="secondary" data-role-add="${index}" ${savingFamily ? "disabled" : ""}>Add specialist role</button>
    </div>
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
    ${errors.roles ? `<div class="field-error" role="alert">${escapeHtml(errors.roles)}</div>` : ""}
    <p class="family-role-help">The orchestrator starts each execution. Specialist labels help it choose models through the harness's native tools. Labels do not grant permissions or require delegation.</p>
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
        <label class="family-enabled"><input type="checkbox" data-family-enabled="${index}" ${family.enabled ? "checked" : ""} ${familyVisibilityGate.isPending() ? "disabled" : ""} /><span>Enabled</span></label>
      </div>
      <ol class="family-members">${family.models.map(memberReadOnly).join("")}</ol>
      <div class="family-card-actions">
        <button type="button" class="secondary" data-family-left="${index}" ${savingOrder || index === 0 ? "disabled" : ""}>← Move</button>
        <button type="button" class="secondary" data-family-right="${index}" ${savingOrder || index === settings.families.length - 1 ? "disabled" : ""}>Move →</button>
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
  const recovery = defaultFamilyRecoveryPresentation(settings);
  $("#defaultHarnessSelect").innerHTML = harnessOptions(recovery);
  $("#defaultProviderSelect").innerHTML = defaultProviderOptions();
  $("#defaultHarnessSelect").disabled = savingDefaults || Boolean(recovery && recovery.action !== "families");
  $("#defaultProviderSelect").disabled = savingDefaults;
  const providerHint = defaultProviderHint(defaultProviderChoices(settings), settings.defaults?.providerId);
  $("#defaultProviderHint").textContent = providerHint ?? "";
  $("#defaultProviderHint").classList.toggle("hidden", !providerHint);
  $("#defaultFamilyRecovery").classList.toggle("hidden", !recovery);
  const canAct = ["providers", "families"].includes(recovery?.action) || Boolean(providerModelsRefreshAction());
  const busy = refreshingDefaultFamily && recovery?.action === "refresh";
  // Only the message text is a live region; it changes only when the recovery does.
  const title = recovery?.title ?? "";
  const text = recovery?.message ?? "";
  const hint = recovery && !canAct ? "Choose another default provider above to send meanwhile." : "";
  if ($("#defaultFamilyRecoveryTitle").textContent !== title) $("#defaultFamilyRecoveryTitle").textContent = title;
  if ($("#defaultFamilyRecoveryText").textContent !== text) $("#defaultFamilyRecoveryText").textContent = text;
  if ($("#defaultFamilyRecoveryHint").textContent !== hint) $("#defaultFamilyRecoveryHint").textContent = hint;
  const refreshButton = $("#refreshDefaultFamilyModels");
  refreshButton.textContent = busy ? "Refreshing…" : recovery?.actionLabel ?? "Refresh models";
  refreshButton.setAttribute("aria-label", (busy ? recovery?.busyName : recovery?.actionName) ?? "Refresh models");
  refreshButton.setAttribute("aria-busy", String(busy));
  refreshButton.classList.toggle("hidden", !canAct);
  refreshButton.setAttribute("aria-disabled", String(refreshingDefaultFamily || savingDefaults));
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
  if (savingOrder) return;
  savingOrder = true;
  const previous = settings.families;
  settings.families = moveItem(settings.families, fromIndex, toIndex);
  selectedFamilyIndex = toIndex;
  render();
  try {
    await saveModelFamilyOrder(settings.families.filter((family) => !family.draft).map((family) => family.id));
    await refreshModelSettings({ preserveEdit: true });
  } catch (error) {
    settings.families = previous;
    selectedFamilyIndex = fromIndex;
    toast(error.message);
  } finally {
    savingOrder = false;
    render();
  }
}

async function persistEnabled(index, enabled) {
  const family = settings.families[index];
  if (!family || !familyVisibilityGate.begin()) {
    render();
    return;
  }
  const previousEnabled = family.enabled;
  family.enabled = enabled;
  render();
  try {
    await updateModelFamily(family.id, family.kind === "system" ? { enabled } : familyPayload(family));
    await refreshModelSettings({ preserveEdit: true });
  } catch (error) {
    const currentFamily = settings.families.find((candidate) => candidate.id === family.id);
    if (currentFamily) currentFamily.enabled = previousEnabled;
    toast(error.message);
  } finally {
    familyVisibilityGate.end();
    render();
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
  const familyId = family.id;
  family.name = $("#familyNameInput").value;
  family.validationErrors = validateCustomFamily(family, settings.families);
  if (Object.keys(family.validationErrors).length) return render();
  savingFamily = true;
  render();
  let persisted = false;
  try {
    const saved = family.draft
      ? await createModelFamily(familyPayload(family))
      : await updateModelFamily(family.id, familyPayload(family));
    const savedFamilyIndex = settings.families.findIndex((candidate) => (
      String(candidate.id) === String(familyId)
    ));
    if (savedFamilyIndex < 0) throw new Error("The saved family is no longer available.");
    settings.families[savedFamilyIndex] = reconcileSavedFamily(family, saved);
    editSnapshot = null;
    persisted = true;
    await refreshModelSettings();
    setStatus("Saved", "success");
  } catch (error) {
    setStatus(persisted ? `Saved, but could not refresh: ${error.message}` : error.message, "error");
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
    await refreshModelSettings({ preserveEdit: true });
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
  $$('[data-member-orchestrator]').forEach((input) => {
    input.onchange = () => updateCurrentFamily((current) => {
      current.models.forEach((member, index) => {
        member.roles = (member.roles ?? []).filter((role) => role.name !== "orchestrator");
        if (index === Number(input.dataset.memberOrchestrator)) member.roles.unshift({ name: "orchestrator" });
      });
    });
  });
  $$('[data-role-add]').forEach((button) => {
    button.onclick = () => updateCurrentFamily((current) => {
      const member = current.models[Number(button.dataset.roleAdd)];
      member.roles ??= [];
      member.roles.push({ name: "" });
    });
  });
  $$('[data-role-remove]').forEach((button) => {
    button.onclick = () => updateCurrentFamily((current) => {
      const [member, role] = button.dataset.roleRemove.split(":").map(Number);
      current.models[member].roles.splice(role, 1);
    });
  });
  for (const [attribute, field] of [["roleName", "name"], ["roleDescription", "description"]]) {
    const selector = attribute === "roleName" ? '[data-role-name]' : '[data-role-description]';
    $$(selector).forEach((input) => {
      input.oninput = () => {
        const [member, role] = input.dataset[attribute].split(":").map(Number);
        const value = input.value.trim();
        family.models[member].roles[role][field] = field === "description" && !value ? undefined : value;
      };
    });
  }
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
  if (savingDefaults) {
    render();
    return;
  }
  savingDefaults = true;
  const previous = { ...settings.defaults };
  const candidate = field === "harnessId"
    ? $("#defaultHarnessSelect").value
    : $("#defaultProviderSelect").value;
  settings.defaults[field] = candidate;
  render();
  let saved = null;
  let harnessNotice = null;
  try {
    let applyPermissionProfiles = field === "harnessId"
      ? await preparePermissionProfiles(candidate)
      : null;
    saved = await saveModelDefaults({ [field]: candidate });
    // The response is the committed defaults. Choosing a provider also selects its managed
    // family, and may move the default harness to one that runs it (PROV-008).
    settings.defaults = { ...saved };
    if (appState.modelSettings) appState.modelSettings.defaults = { ...saved };
    harnessNotice = field === "providerId"
      ? defaultHarnessChangeNotice(previous, saved, settings)
      : null;
    if (harnessNotice) applyPermissionProfiles = await preparePermissionProfiles(saved.harnessId);
    applyPermissionProfiles?.();
    await refreshModelSettings({ preserveEdit: true });
    resetNewThreadModelPicker();
    setStatus(harnessNotice ?? "Saved", "success");
  } catch (error) {
    if (!saved) settings.defaults = previous;
    const savedStatus = harnessNotice ? `${harnessNotice} Could not refresh: ${error.message}` : `Saved, but could not refresh: ${error.message}`;
    setStatus(saved ? savedStatus : error.message, "error");
  } finally {
    savingDefaults = false;
    render();
  }
}

async function refreshDefaultFamilyModels() {
  const recovery = defaultFamilyRecoveryPresentation(settings);
  if (!recovery || refreshingDefaultFamily || savingDefaults) return;
  // A disconnected provider is reconnected from its card under Providers.
  if (recovery.action === "families") {
    const index = settings.families.findIndex((family) => String(family.id) === String(settings.defaults?.familyId));
    if (index >= 0) chooseFamily(index);
    $("#familyCarousel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    $('[data-family-edit="' + index + '"]')?.focus();
    return;
  }
  if (recovery.action === "providers") {
    const providersTab = $('[data-settings-tab="providers"]');
    providersTab?.click();
    // The recovery button is now hidden with the Models tab. Focus goes to the provider's
    // Reconnect action when its card offers one, otherwise to the Providers tab.
    const reconnect = $$("[data-provider-reconnect]")
      .find((button) => button.dataset.providerReconnect === String(recovery.providerId));
    (reconnect ?? providersTab)?.focus();
    return;
  }
  const refreshButton = $("#refreshDefaultFamilyModels");
  refreshingDefaultFamily = true;
  render();
  setStatus("Refreshing provider models…");
  try {
    await refreshProviderModels(recovery.providerId);
    const remaining = defaultFamilyRecoveryPresentation(settings);
    setStatus(remaining ? remaining.message : "Provider models refreshed.", remaining ? "" : "success");
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    refreshingDefaultFamily = false;
    render();
    // The button is kept, not re-created, so focus stays on it. Once the family is restored the
    // button hides; if focus was still on it, it moves to the provider choice beside it.
    const active = document.activeElement;
    if ($("#defaultFamilyRecovery").classList.contains("hidden")
      && (active === refreshButton || active === document.body || !active)) {
      $("#defaultProviderSelect").focus();
    }
  }
}

function bindStaticEvents() {
  $("#refreshDefaultFamilyModels").onclick = () => void refreshDefaultFamilyModels();
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
  return refreshModelSettings({ preserveEdit: true });
}
