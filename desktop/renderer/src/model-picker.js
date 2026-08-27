import {
  availablePickerFamilies,
  harnessUsesConfigurationModel,
  modelPickerContextCandidate,
  pickerSelectionIsAvailable,
  reconcilePickerSelection,
  resolveUnsentModelIntent,
  validateCandidateHarness,
} from "./model-picker-model.js";
import { escapeHtml, escapeHtmlAttribute } from "./ui.js";

const TABS = ["model", "advanced"];

function modelFor(settings, providerId, modelId) {
  return settings?.providers
    ?.find((provider) => provider.id === providerId)
    ?.models?.find((model) => model.id === modelId);
}

function familyFor(settings, familyId) {
  return settings?.families?.find((family) => String(family.id) === String(familyId));
}

function harnessFor(settings, harnessId) {
  return settings?.harnesses?.find((harness) => harness.id === harnessId);
}

export function modelPickerFamilyPresentation(settings, harnessId, selection) {
  const families = settings ? availablePickerFamilies(settings, harnessId) : [];
  const selectedFamily = families.find((family) => (
    String(family.id) === String(selection?.familyId)
  )) ?? families[0] ?? null;
  return {
    families,
    selectedFamily,
    requiresExplicitSelection: Boolean(selectedFamily) && !pickerSelectionIsAvailable(settings, selection),
  };
}

export function modelPickerMemberIsSelected(familyId, selection, member) {
  return String(familyId) === String(selection?.familyId)
    && member.providerId === selection?.providerId
    && member.modelId === selection?.modelId;
}

export function modelPickerMarkup({ mode = "new" } = {}) {
  const safeMode = mode === "ongoing" ? "ongoing" : "new";
  return `<div class="model-control model-control-${safeMode}" data-model-picker="${safeMode}">
    <button type="button" class="model-button" data-model-picker-trigger aria-haspopup="dialog" aria-expanded="false" title="Choose model"><span aria-hidden="true">✦</span><span data-model-picker-label>Model</span><span aria-hidden="true">⌄</span></button>
    <div class="model-picker-popover hidden" data-model-picker-popover role="dialog" aria-label="Model and harness picker">
      <div class="model-picker-tabs" role="tablist" aria-label="Model picker sections">
        <button type="button" role="tab" data-model-picker-tab="model" aria-selected="true">Model</button>
        <button type="button" role="tab" data-model-picker-tab="advanced" aria-selected="false">Advanced</button>
      </div>
      <section class="model-picker-panel" data-model-picker-panel="model" role="tabpanel"></section>
      <section class="model-picker-panel hidden" data-model-picker-panel="advanced" role="tabpanel"></section>
      <p class="model-picker-error hidden" data-model-picker-error role="alert"></p>
    </div>
  </div>`;
}

export function modelPickerKeyIntent(event, activeTab = "model") {
  if (event.key === "Escape") return "close";
  if (!event.target?.matches?.('[role="tab"]')) return null;
  if (event.key === "ArrowRight") return TABS[(TABS.indexOf(activeTab) + 1) % TABS.length];
  if (event.key === "ArrowLeft") return TABS[(TABS.indexOf(activeTab) + TABS.length - 1) % TABS.length];
  if (event.key === "Home") return TABS[0];
  if (event.key === "End") return TABS.at(-1);
  return null;
}

export function modelPickerCycleIndex(currentIndex, itemCount, key) {
  if (itemCount <= 0 || !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(key)) {
    return null;
  }
  const direction = key === "ArrowDown" || key === "ArrowRight" ? 1 : -1;
  return (currentIndex + direction + itemCount) % itemCount;
}

export function modelPickerClickIsOutside(root, target) {
  return !root.contains(target);
}

export function createModelPickerRequestGate() {
  let sequence = 0;
  return Object.freeze({
    begin: () => ++sequence,
    invalidate: () => { sequence += 1; },
    isCurrent: (candidate) => candidate === sequence,
  });
}

export function modelSelectionLabels(settings, selection) {
  if (!settings || !selection?.providerId || !selection?.modelId) return null;
  const family = familyFor(settings, selection.familyId);
  const provider = settings.providers?.find((item) => item.id === selection.providerId);
  const model = modelFor(settings, selection.providerId, selection.modelId);
  const providerLabel = provider?.label ?? selection.providerId;
  const modelLabel = model?.label ?? selection.modelId;
  return {
    family: family?.name ?? null,
    provider: providerLabel,
    model: modelLabel,
    compact: family ? `${family.name} · ${modelLabel}` : `${providerLabel} · ${modelLabel}`,
  };
}

export function interactionModelSelection(interaction) {
  const canonical = interaction?.modelSelection;
  if (canonical?.familyId != null && canonical?.providerId && canonical?.modelId) {
    return {
      familyId: canonical.familyId,
      providerId: canonical.providerId,
      modelId: canonical.modelId,
    };
  }
  if (
    interaction?.modelFamilyId != null
    && interaction?.modelProviderId
    && interaction?.providerModelId
  ) {
    return {
      familyId: interaction.modelFamilyId,
      providerId: interaction.modelProviderId,
      modelId: interaction.providerModelId,
    };
  }
  return null;
}

export function selectionForNextInteraction(settings, harnessId, interaction) {
  if (!settings || !harnessId) return null;
  const prior = interactionModelSelection(interaction);
  const resolution = resolveUnsentModelIntent(settings, { harnessId, ...prior });
  if (resolution.selection) return resolution.selection;
  return resolution.blockedFamilyId != null && prior ? { harnessId, ...prior } : null;
}

export function createModelPicker({
  root,
  mode = "new",
  settings = null,
  pinnedHarnessId = null,
  selection = null,
  onUserTakeover = () => {},
  onSelectionChange = () => {},
  onOpenSettings = () => {},
  prepareHarnessChange = async () => () => {},
  validateSelection = async () => {},
}) {
  if (!root) throw new Error("Model picker requires a root element.");
  const trigger = root.querySelector("[data-model-picker-trigger]");
  const popover = root.querySelector("[data-model-picker-popover]");
  const triggerLabel = root.querySelector("[data-model-picker-label]");
  const errorElement = root.querySelector("[data-model-picker-error]");
  let currentSettings = settings;
  let currentPinnedHarnessId = pinnedHarnessId;
  let currentSelection = currentSettings
    ? reconcilePickerSelection(currentSettings, selection ?? {
      harnessId: currentPinnedHarnessId ?? currentSettings.defaults?.harnessId,
    })
    : null;
  let activeTab = "model";
  let error = null;
  let disabled = false;
  let validatingHarness = false;
  const harnessValidationGate = createModelPickerRequestGate();

  function selectionReady() {
    return !validatingHarness && pickerSelectionIsAvailable(currentSettings, currentSelection);
  }

  function selectedHarnessId() {
    return mode === "ongoing"
      ? currentPinnedHarnessId
      : currentSelection?.harnessId ?? currentSettings?.defaults?.harnessId;
  }

  function commit(nextSelection) {
    harnessValidationGate.invalidate();
    validatingHarness = false;
    currentSelection = nextSelection;
    error = null;
    render();
    onSelectionChange(currentSelection);
  }

  function renderModelPanel() {
    const panel = root.querySelector('[data-model-picker-panel="model"]');
    const { families, selectedFamily } = modelPickerFamilyPresentation(
      currentSettings,
      selectedHarnessId(),
      currentSelection,
    );
    if (!selectedFamily) {
      if (harnessUsesConfigurationModel(currentSettings, selectedHarnessId())) {
        panel.innerHTML = `<div class="model-picker-empty"><strong>Harness default</strong><span>The model is set by this harness configuration.</span></div>`;
        return;
      }
      panel.innerHTML = `<div class="model-picker-empty"><strong>No available models</strong><button type="button" class="secondary" data-model-picker-settings>Open Settings</button></div>`;
      panel.querySelector("[data-model-picker-settings]").onclick = () => {
        onUserTakeover();
        close();
        onOpenSettings();
      };
      return;
    }
    panel.innerHTML = `<label class="model-family-field"><span>Family</span><select data-model-family aria-label="Model family">${families.map((family) => `<option value="${escapeHtmlAttribute(family.id)}" ${String(family.id) === String(selectedFamily.id) ? "selected" : ""}>${escapeHtml(family.name)}</option>`).join("")}</select></label>
      <div class="model-option-list" role="radiogroup" aria-label="Models in ${escapeHtmlAttribute(selectedFamily.name)}">${selectedFamily.availableMembers.map((member) => {
        const model = modelFor(currentSettings, member.providerId, member.modelId);
        const provider = currentSettings.providers.find((item) => item.id === member.providerId);
        const checked = modelPickerMemberIsSelected(selectedFamily.id, currentSelection, member);
        return `<button type="button" role="radio" aria-checked="${checked}" data-model-option data-provider-id="${escapeHtmlAttribute(member.providerId)}" data-model-id="${escapeHtmlAttribute(member.modelId)}"><span><strong>${escapeHtml(model?.label ?? member.modelId)}</strong><small>${escapeHtml(provider?.label ?? member.providerId)}</small></span><i aria-hidden="true">${checked ? "✓" : ""}</i></button>`;
      }).join("")}</div>`;
    panel.querySelector("[data-model-family]").onchange = (event) => {
      onUserTakeover();
      const nextFamily = families.find((family) => String(family.id) === event.target.value);
      const member = nextFamily?.availableMembers[0];
      if (!member) return;
      commit({
        harnessId: selectedHarnessId(),
        familyId: nextFamily.id,
        providerId: member.providerId,
        modelId: member.modelId,
      });
      requestAnimationFrame(() => root.querySelector("[data-model-family]")?.focus());
    };
    panel.querySelectorAll("[data-model-option]").forEach((button) => {
      button.onclick = () => {
        onUserTakeover();
        const providerId = button.dataset.providerId;
        const modelId = button.dataset.modelId;
        commit({
          harnessId: selectedHarnessId(),
          familyId: selectedFamily.id,
          providerId,
          modelId,
        });
        requestAnimationFrame(() => [...root.querySelectorAll("[data-model-option]")]
          .find((candidate) => (
            candidate.dataset.providerId === providerId
            && candidate.dataset.modelId === modelId
          ))?.focus());
      };
    });
  }

  function renderAdvancedPanel() {
    const panel = root.querySelector('[data-model-picker-panel="advanced"]');
    const harnessId = selectedHarnessId();
    if (mode === "ongoing") {
      const harness = harnessFor(currentSettings, harnessId);
      panel.innerHTML = `<div class="pinned-harness"><span>Harness</span><strong>${escapeHtml(harness?.label ?? harnessId ?? "Unavailable")}</strong><small>Pinned for this thread</small></div>`;
      return;
    }
    const harnesses = (currentSettings?.harnesses ?? []).filter((harness) => (
      harness.available !== false
      && (
        availablePickerFamilies(currentSettings, harness.id).length > 0
        || harnessUsesConfigurationModel(currentSettings, harness.id)
      )
    ));
    panel.innerHTML = harnesses.length
      ? `<div class="harness-option-list" role="radiogroup" aria-label="Harnesses">${harnesses.map((harness) => {
        const checked = harness.id === harnessId;
        return `<button type="button" role="radio" aria-checked="${checked}" data-harness-option="${escapeHtmlAttribute(harness.id)}" ${validatingHarness ? "disabled" : ""}><span><strong>${escapeHtml(harness.label)}</strong></span><i aria-hidden="true">${checked ? "✓" : ""}</i></button>`;
      }).join("")}</div>`
      : `<div class="model-picker-empty"><strong>No available harnesses</strong><button type="button" class="secondary" data-model-picker-settings>Open Settings</button></div>`;
    panel.querySelector("[data-model-picker-settings]")?.addEventListener("click", () => {
      onUserTakeover();
      close();
      onOpenSettings();
    });
    panel.querySelectorAll("[data-harness-option]").forEach((button) => {
      button.onclick = async () => {
        onUserTakeover();
        const candidateHarnessId = button.dataset.harnessOption;
        const validationSequence = harnessValidationGate.begin();
        validatingHarness = true;
        error = null;
        render();
        onSelectionChange(null);
        const result = await validateCandidateHarness(
          currentSettings,
          currentSelection,
          candidateHarnessId,
          validateSelection,
        );
        if (!harnessValidationGate.isCurrent(validationSequence)) return;
        if (result.error) {
          validatingHarness = false;
          error = result.error;
          render();
          onSelectionChange(selectionReady() ? currentSelection : null);
          [...root.querySelectorAll("[data-harness-option]")]
            .find((candidate) => candidate.dataset.harnessOption === candidateHarnessId)
            ?.focus();
          return;
        }
        let applyHarnessChange;
        try {
          applyHarnessChange = await prepareHarnessChange(candidateHarnessId);
          if (!harnessValidationGate.isCurrent(validationSequence)) return;
          if (typeof applyHarnessChange !== "function") {
            throw new Error("Harness change preparation must return an apply function.");
          }
          applyHarnessChange();
        } catch (changeError) {
          if (!harnessValidationGate.isCurrent(validationSequence)) return;
          validatingHarness = false;
          error = changeError instanceof Error ? changeError.message : String(changeError);
          render();
          onSelectionChange(selectionReady() ? currentSelection : null);
          return;
        }
        commit(result.selection);
        requestAnimationFrame(() => [...root.querySelectorAll("[data-harness-option]")]
          .find((candidate) => candidate.dataset.harnessOption === candidateHarnessId)
          ?.focus());
      };
    });
  }

  function render() {
    const ready = selectionReady();
    const labels = ready ? modelSelectionLabels(currentSettings, currentSelection) : null;
    const configurationOwnedModel = ready
      && harnessUsesConfigurationModel(currentSettings, selectedHarnessId());
    const hasAvailableModels = currentSettings
      ? availablePickerFamilies(currentSettings, selectedHarnessId()).length > 0
      : false;
    triggerLabel.textContent = labels?.compact
      ?? (configurationOwnedModel ? "Harness default" : (hasAvailableModels ? "Choose model" : "Set up models"));
    trigger.title = labels
      ? `Model: ${labels.compact}`
      : (configurationOwnedModel ? "Model set by harness configuration" : "Choose an available model");
    trigger.disabled = disabled;
    root.querySelectorAll("[data-model-picker-tab]").forEach((tab) => {
      const selected = tab.dataset.modelPickerTab === activeTab;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    root.querySelectorAll("[data-model-picker-panel]").forEach((panel) => {
      panel.classList.toggle("hidden", panel.dataset.modelPickerPanel !== activeTab);
    });
    renderModelPanel();
    renderAdvancedPanel();
    errorElement.textContent = error ?? "";
    errorElement.classList.toggle("hidden", !error);
  }

  function open(tab = activeTab) {
    if (disabled) return;
    activeTab = TABS.includes(tab) ? tab : "model";
    error = null;
    render();
    popover.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => root.querySelector(`[data-model-picker-tab="${activeTab}"]`)?.focus());
  }

  function close({ returnFocus = false } = {}) {
    harnessValidationGate.invalidate();
    const wasValidatingHarness = validatingHarness;
    validatingHarness = false;
    popover.classList.add("hidden");
    trigger.setAttribute("aria-expanded", "false");
    if (wasValidatingHarness) onSelectionChange(selectionReady() ? currentSelection : null);
    if (returnFocus) trigger.focus();
  }

  function setActiveTab(tab, { focus = false } = {}) {
    if (!TABS.includes(tab)) return;
    activeTab = tab;
    render();
    if (focus) root.querySelector(`[data-model-picker-tab="${tab}"]`)?.focus();
  }

  trigger.onclick = () => {
    onUserTakeover();
    if (popover.classList.contains("hidden")) open();
    else close();
  };
  root.querySelectorAll("[data-model-picker-tab]").forEach((tab) => {
    tab.onclick = () => setActiveTab(tab.dataset.modelPickerTab);
  });
  root.onkeydown = (event) => {
    const intent = modelPickerKeyIntent(event, activeTab);
    if (intent === "close") {
      event.preventDefault();
      close({ returnFocus: true });
      return;
    }
    if (TABS.includes(intent)) {
      event.preventDefault();
      setActiveTab(intent, { focus: true });
      return;
    }
    const option = event.target.closest?.('[role="radio"]');
    if (!option) return;
    const options = [...option.parentElement.querySelectorAll('[role="radio"]')];
    const index = modelPickerCycleIndex(options.indexOf(option), options.length, event.key);
    if (index == null) return;
    event.preventDefault();
    options[index].focus();
    options[index].click();
  };
  const outsideClick = (event) => {
    if (modelPickerClickIsOutside(root, event.target)) close();
  };
  root.ownerDocument.addEventListener("click", outsideClick);

  render();

  return Object.freeze({
    close,
    dispose() {
      harnessValidationGate.invalidate();
      root.ownerDocument.removeEventListener("click", outsideClick);
      trigger.onclick = null;
      root.onkeydown = null;
      root.querySelectorAll("[data-model-picker-tab]").forEach((tab) => { tab.onclick = null; });
    },
    getSelection: () => selectionReady() ? { ...currentSelection } : null,
    isReady: selectionReady,
    open,
    setDisabled(nextDisabled) {
      disabled = Boolean(nextDisabled);
      if (disabled) close();
      render();
    },
    setContext({
      settings: nextSettings = currentSettings,
      pinnedHarnessId: nextPinnedHarnessId = currentPinnedHarnessId,
      selection: nextSelection,
      replaceSelection = false,
    } = {}) {
      harnessValidationGate.invalidate();
      validatingHarness = false;
      currentSettings = nextSettings;
      currentPinnedHarnessId = nextPinnedHarnessId;
      currentSelection = currentSettings
        ? reconcilePickerSelection(currentSettings, modelPickerContextCandidate({
          settings: currentSettings,
          mode,
          pinnedHarnessId: currentPinnedHarnessId,
          currentSelection,
          nextSelection,
          replaceSelection,
        }))
        : null;
      error = null;
      render();
      onSelectionChange(selectionReady() ? currentSelection : null);
    },
  });
}
