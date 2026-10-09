import {
  availableFamilyMembers,
  availablePickerFamilies,
  familyModelSetup,
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

// A family that needs model setup stays the selection (PROV-008), whether it is the default or a
// thread's last family: the picker names it and offers its provider's refresh instead of
// pre-showing another family.
export function modelPickerModelSetup(settings, selection) {
  if (!settings || pickerSelectionIsAvailable(settings, selection)) return null;
  const compatibility = settings.conversationCompatibility;
  const setup = familyModelSetup(settings, selection?.familyId ?? settings.defaults?.familyId, selection?.harnessId ?? settings.defaults?.harnessId);
  if (compatibility?.status === "blocked") return null;
  if (compatibility?.status === "compatible" && (
    setup?.providerId !== compatibility.providerId
    || selection?.harnessId !== compatibility.harnessId
  )) return null;
  return setup;
}

export function modelPickerFamilyPresentation(settings, harnessId, selection) {
  const families = settings ? availablePickerFamilies(settings, harnessId) : [];
  const modelSetup = modelPickerModelSetup(settings, selection);
  const selectedFamily = families.find((family) => (
    String(family.id) === String(selection?.familyId)
  )) ?? (modelSetup ? null : families[0] ?? null);
  return {
    families,
    selectedFamily,
    modelSetup,
    requiresExplicitSelection: Boolean(selectedFamily) && !pickerSelectionIsAvailable(settings, selection),
  };
}

export function composerSendTitle({ ready, modelSetup = null, readyTitle }) {
  if (ready) return readyTitle;
  if (modelSetup) return `${modelSetup.label}. ${modelSetup.actionName} to send.`;
  return "Choose an available model in Settings before sending";
}

export function modelPickerMemberIsSelected(familyId, selection, member) {
  return String(familyId) === String(selection?.familyId)
    && member.providerId === selection?.providerId
    && member.modelId === selection?.modelId;
}

export function modelPickerMarkup({ mode = "new" } = {}) {
  const safeMode = mode === "ongoing" ? "ongoing" : "new";
  return `<div class="model-control model-control-${safeMode}" data-model-picker="${safeMode}">
    <button type="button" class="model-button" data-model-picker-trigger aria-haspopup="dialog" aria-expanded="false" title="Choose model family"><span aria-hidden="true">✦</span><span data-model-picker-label>Model</span><span aria-hidden="true">⌄</span></button>
    <div class="model-picker-popover hidden" data-model-picker-popover role="dialog" aria-label="Model and harness picker">
      <div class="model-picker-tabs" role="tablist" aria-label="Model picker sections">
        <button type="button" role="tab" data-model-picker-tab="model" aria-selected="true">Family</button>
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

// Picker handlers re-render their panel, which detaches the clicked element before the
// document-level dismissal listener sees the same click. Record the verdict in the capture
// phase, while the element the person actually clicked is still in the tree.
export function createModelPickerDismissWatcher(root) {
  let dismiss = true;
  return Object.freeze({
    observe: (event) => { dismiss = modelPickerClickIsOutside(root, event.target); },
    shouldDismiss: () => dismiss,
  });
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
    compact: family ? family.name : `${providerLabel} · ${modelLabel}`,
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
  onRefreshModels = null,
  prepareHarnessChange = async () => () => {},
  validateSelection = async () => {},
}) {
  if (!root) throw new Error("Model picker requires a root element.");
  const trigger = root.querySelector("[data-model-picker-trigger]");
  const popover = root.querySelector("[data-model-picker-popover]");
  const triggerLabel = root.querySelector("[data-model-picker-label]");
  const errorElement = root.querySelector("[data-model-picker-error]");
  // One live region outside the re-rendered panels announces a recovery state once.
  let statusElement = root.querySelector("[data-model-picker-status]");
  if (!statusElement) {
    statusElement = root.ownerDocument.createElement("p");
    statusElement.className = "sr-only";
    statusElement.dataset.modelPickerStatus = "";
    statusElement.setAttribute("role", "status");
    root.append(statusElement);
  }
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
  let refreshingModels = false;
  const harnessValidationGate = createModelPickerRequestGate();
  let swipeDelta = 0;
  let swipeDirection = 0;
  let lastSwipeTime = null;
  let swipeTimer = null;
  let familyAnimations = [];

  function clearFamilyMotion() {
    familyAnimations.forEach((animation) => animation.cancel());
    familyAnimations = [];
    root.querySelectorAll("[data-family-outgoing]").forEach((element) => element.remove());
    const list = root.querySelector(".model-family-members");
    if (list) list.style.transform = "";
  }

  function reducedFamilyMotion() {
    return root.ownerDocument.defaultView.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  function settleFamilyDrag() {
    const list = root.querySelector(".model-family-members");
    if (!list?.style.transform) return;
    const from = list.style.transform;
    list.style.transform = "";
    if (!reducedFamilyMotion() && list.animate) {
      familyAnimations.push(list.animate([{ transform: from }, { transform: "translateX(0)" }],
        { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" }));
    }
  }

  function resetSwipe() {
    swipeDelta = 0;
    swipeDirection = 0;
    lastSwipeTime = null;
    clearTimeout(swipeTimer);
    swipeTimer = null;
    clearFamilyMotion();
  }

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

  function familyOptions(families, selectedFamily) {
    return families.map((family) => `<option value="${escapeHtmlAttribute(family.id)}" ${String(family.id) === String(selectedFamily?.id) ? "selected" : ""}>${escapeHtml(family.name)}</option>`).join("");
  }

  function familyFieldMarkup(families, selectedFamily, setupName = null) {
    return `<div class="model-family-field"><span>Family</span>
      <select data-model-family aria-label="Model family">${setupName ? `<option value="" selected disabled>${escapeHtml(setupName)}</option>` : ""}${familyOptions(families, selectedFamily)}</select>
    </div>`;
  }

  function familyMembersMarkup(family, families, selectedFamily) {
    if (!family && !families.length) return "";
    const canCycle = families.length > 1 || (families.length === 1 && !selectedFamily);
    const arrow = (direction, label, glyph) => `<button type="button" class="model-family-cycle" data-family-cycle="${direction}" aria-label="${label}" title="${label}" ${canCycle ? "" : "disabled"}><span aria-hidden="true">${glyph}</span></button>`;
    const available = family ? availableFamilyMembers(currentSettings, family, selectedHarnessId()) : [];
    return `<div class="model-family-roster" data-family-roster>${arrow("previous", "Previous model family", "‹")}<div class="model-family-viewport"><ul class="model-family-members" aria-label="Family models and roles">${[...(family?.members ?? [])]
      .sort((left, right) => left.position - right.position)
      .map((member) => {
        const provider = currentSettings.providers.find((item) => item.id === member.providerId);
        const model = modelFor(currentSettings, member.providerId, member.modelId);
        const isAvailable = available.some((candidate) => candidate.providerId === member.providerId && candidate.modelId === member.modelId);
        const roles = (member.roles ?? []).map((role) => `<span class="model-family-role"${role.description ? ` title="${escapeHtmlAttribute(role.description)}"` : ""}>${escapeHtml(role.name)}</span>`).join("");
        return `<li class="model-family-member${isAvailable ? "" : " model-family-member-unavailable"}"><button type="button" class="model-family-member-button" data-family-member>
          <span class="model-family-member-heading"><strong>${escapeHtml(model?.label ?? member.modelId)}</strong>${isAvailable ? "" : '<small class="model-family-member-status">Unavailable</small>'}</span>
          <span class="model-family-member-meta"><small class="model-family-member-provider">${escapeHtml(provider?.label ?? member.providerId)}</small><span class="model-family-member-roles">${roles || '<span class="model-family-no-role">No role assigned</span>'}</span></span>
        </button></li>`;
      }).join("")}</ul></div>${arrow("next", "Next model family", "›")}</div>`;
  }

  function chooseFamily(nextFamily) {
    const member = nextFamily?.orchestrator;
    if (!member) return;
    onUserTakeover();
    commit({
      harnessId: selectedHarnessId(),
      familyId: nextFamily.id,
      providerId: member.providerId,
      modelId: member.modelId,
    });
  }

  function cycleFamily(direction, { focus = true } = {}) {
    const { families, selectedFamily } = modelPickerFamilyPresentation(currentSettings, selectedHarnessId(), currentSelection);
    if (!families.length || (families.length === 1 && selectedFamily)) return;
    const currentIndex = families.findIndex((family) => String(family.id) === String(currentSelection?.familyId));
    const nextIndex = currentIndex < 0
      ? (direction === "next" ? 0 : families.length - 1)
      : (currentIndex + (direction === "next" ? 1 : -1) + families.length) % families.length;
    const outgoing = root.querySelector(".model-family-members")?.cloneNode(true);
    clearFamilyMotion();
    chooseFamily(families[nextIndex]);
    const incoming = root.querySelector(".model-family-members");
    if (outgoing && incoming?.animate && !reducedFamilyMotion()) {
      const sign = direction === "next" ? 1 : -1;
      outgoing.setAttribute("data-family-outgoing", "");
      outgoing.setAttribute("aria-hidden", "true");
      outgoing.inert = true;
      incoming.parentElement.append(outgoing);
      const timing = { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" };
      const exit = outgoing.animate([
        { transform: outgoing.style.transform || "translateX(0)", opacity: 1 },
        { transform: `translateX(${-sign * 100}%)`, opacity: 0 },
      ], timing);
      exit.onfinish = () => outgoing.remove();
      familyAnimations = [exit, incoming.animate([
        { transform: `translateX(${sign * 100}%)`, opacity: 0.3 },
        { transform: "translateX(0)", opacity: 1 },
      ], timing)];
    }
    if (!focus) return;
    const nextButton = root.querySelector(`[data-family-cycle="${direction}"]`);
    (nextButton?.disabled ? root.querySelector("[data-model-family]") : nextButton)?.focus();
  }

  function bindFamilyChange(panel, families) {
    panel.querySelector("[data-model-family]").onchange = (event) => {
      chooseFamily(families.find((family) => String(family.id) === event.target.value));
      close({ returnFocus: true });
    };
    panel.querySelectorAll("[data-family-cycle]").forEach((button) => {
      button.onclick = () => {
        resetSwipe();
        cycleFamily(button.dataset.familyCycle);
      };
    });
  }

  function renderModelSetupPanel(panel, families, modelSetup) {
    const refresh = onRefreshModels && modelSetup.action === "refresh"
      ? `<button type="button" class="secondary" data-model-picker-refresh aria-label="${escapeHtmlAttribute(refreshingModels ? modelSetup.busyName : modelSetup.actionName)}" aria-busy="${refreshingModels}" aria-disabled="${refreshingModels}">${refreshingModels ? "Refreshing…" : escapeHtml(modelSetup.actionLabel)}</button>`
      : `<button type="button" class="secondary" data-model-picker-settings${modelSetup.action === "settings" ? ` aria-label="${escapeHtmlAttribute(modelSetup.actionName)}"` : ""}>Open Settings</button>`;
    const otherFamilies = families.length
      ? familyFieldMarkup(families, null, modelSetup.familyName)
      : "";
    panel.innerHTML = `<div class="model-picker-empty model-picker-recovery"><strong>${escapeHtml(modelSetup.label)}</strong><span>${escapeHtml(modelSetup.message)}</span>${refresh}</div>${otherFamilies}${familyMembersMarkup(familyFor(currentSettings, modelSetup.familyId), families, null)}`;
    if (families.length) bindFamilyChange(panel, families);
    // A disconnected provider is reconnected on its card under Providers; otherwise the Settings
    // defaults show the recovery and the other providers.
    panel.querySelector("[data-model-picker-settings]")?.addEventListener("click", () => {
      onUserTakeover();
      close();
      onOpenSettings(modelSetup.action === "settings" ? "providers" : "models");
    });
    const refreshButton = panel.querySelector("[data-model-picker-refresh]");
    if (!refreshButton) return;
    // Each render replaces the panel and drops focus to the page. Focus returns to the refresh
    // action, or to the first model once the family is restored, unless the user moved it away.
    const restoreFocus = () => requestAnimationFrame(() => {
      const document = root.ownerDocument;
      const active = document.activeElement;
      if (active && active !== document.body && !root.contains(active)) return;
      if (popover.classList.contains("hidden")) return;
      (root.querySelector("[data-model-picker-refresh]")
        ?? root.querySelector("[data-model-option]")
        ?? root.querySelector("[data-model-family]")
        ?? root.querySelector('[data-model-picker-tab="model"]'))?.focus();
    });
    refreshButton.onclick = async () => {
      if (refreshingModels) return;
      onUserTakeover();
      refreshingModels = true;
      error = null;
      render();
      restoreFocus();
      try {
        await onRefreshModels(modelSetup.providerId);
      } catch (refreshError) {
        error = refreshError instanceof Error ? refreshError.message : String(refreshError);
      } finally {
        refreshingModels = false;
        render();
        restoreFocus();
      }
    };
  }

  function renderModelPanel() {
    const panel = root.querySelector('[data-model-picker-panel="model"]');
    const { families, selectedFamily, modelSetup } = modelPickerFamilyPresentation(
      currentSettings,
      selectedHarnessId(),
      currentSelection,
    );
    if (!selectedFamily && modelSetup) {
      renderModelSetupPanel(panel, families, modelSetup);
      return;
    }
    if (!selectedFamily) {
      if (harnessUsesConfigurationModel(currentSettings, selectedHarnessId())) {
        panel.innerHTML = `<div class="model-picker-empty"><strong>Harness default</strong><span>The model is set by this harness configuration.</span></div>`;
        return;
      }
      const compatibility = currentSettings?.conversationCompatibility;
      const unavailableMessage = compatibility?.status === "compatible"
        ? "Reconnect the original provider or enable a compatible model in Settings."
        : compatibility?.message ?? "Connect an available provider in Settings.";
      panel.innerHTML = `<div class="model-picker-empty"><strong>${compatibility?.status && compatibility.status !== "unrestricted" ? "No compatible route available" : "No available models"}</strong><span>${escapeHtml(unavailableMessage)}</span><button type="button" class="secondary" data-model-picker-settings>Open Settings</button></div>`;
      panel.querySelector("[data-model-picker-settings]").onclick = () => {
        onUserTakeover();
        close();
        onOpenSettings();
      };
      return;
    }
    panel.innerHTML = `${familyFieldMarkup(families, selectedFamily)}
      ${familyMembersMarkup(selectedFamily, families, selectedFamily)}`;
    bindFamilyChange(panel, families);
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
    const modelSetup = ready ? null : modelPickerModelSetup(currentSettings, currentSelection);
    triggerLabel.textContent = labels?.compact
      ?? (configurationOwnedModel ? "Harness default" : modelSetup?.label ?? (hasAvailableModels ? "Choose family" : "Set up models"));
    trigger.title = labels
      ? `Model: ${labels.compact}`
      : (configurationOwnedModel ? "Model set by harness configuration" : modelSetup?.message ?? "Choose an available family");
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
    root.querySelectorAll("[data-family-member]").forEach((button) => {
      button.onclick = () => {
        onUserTakeover();
        close({ returnFocus: true });
      };
    });
    const status = modelSetup?.message ?? "";
    if (statusElement.textContent !== status) statusElement.textContent = status;
    const compatibilityNotice = currentSettings?.conversationCompatibility?.status === "compatible"
      ? "Only models from the original provider are available."
      : currentSettings?.conversationCompatibility?.message;
    const notice = error ?? (hasAvailableModels ? compatibilityNotice : null);
    errorElement.textContent = notice ?? "";
    errorElement.classList.toggle("model-picker-warning", !error && Boolean(notice));
    errorElement.setAttribute("role", error ? "alert" : "status");
    errorElement.classList.toggle("hidden", !notice);
  }

  function open(tab = activeTab) {
    if (disabled) return;
    resetSwipe();
    activeTab = TABS.includes(tab) ? tab : "model";
    error = null;
    render();
    popover.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => root.querySelector(`[data-model-picker-tab="${activeTab}"]`)?.focus());
  }

  function close({ returnFocus = false } = {}) {
    resetSwipe();
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
    resetSwipe();
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
  const dismissWatcher = createModelPickerDismissWatcher(root);
  const outsideClick = () => {
    if (dismissWatcher.shouldDismiss()) close();
  };
  root.ownerDocument.addEventListener("click", dismissWatcher.observe, true);
  root.ownerDocument.addEventListener("click", outsideClick);
  const onFamilyWheel = (event) => {
    if (disabled || popover.classList.contains("hidden") || activeTab !== "model"
      || !event.target.closest?.("[data-family-roster]") || event.ctrlKey || event.metaKey || event.altKey) return;
    if (lastSwipeTime === null || event.timeStamp - lastSwipeTime > 180) resetSwipe();
    lastSwipeTime = event.timeStamp;
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || event.deltaX === 0) {
      if (!swipeDirection) {
        swipeDelta = 0;
        settleFamilyDrag();
      }
      return;
    }
    const { families, selectedFamily } = modelPickerFamilyPresentation(currentSettings, selectedHarnessId(), currentSelection);
    if (!families.length || (families.length === 1 && selectedFamily)) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? popover.clientWidth || 300 : 1;
    const delta = event.deltaX * scale;
    // Same-direction momentum cannot run through the catalog. A meaningful
    // reversal starts a new movement immediately, without waiting for idle.
    if (Math.sign(delta) === swipeDirection) {
      swipeDelta = 0;
      return;
    }
    if (Math.sign(swipeDelta) !== Math.sign(delta)) swipeDelta = 0;
    swipeDelta += delta;
    const list = root.querySelector(".model-family-members");
    if (list && !reducedFamilyMotion()) {
      clearFamilyMotion();
      list.style.transform = `translateX(${-Math.max(-60, Math.min(60, swipeDelta))}px)`;
    }
    clearTimeout(swipeTimer);
    swipeTimer = setTimeout(settleFamilyDrag, 120);
    if (Math.abs(swipeDelta) < 48) return;
    swipeDirection = Math.sign(swipeDelta);
    cycleFamily(swipeDelta > 0 ? "next" : "previous", { focus: false });
    swipeDelta = 0;
    clearTimeout(swipeTimer);
  };
  root.addEventListener("wheel", onFamilyWheel, { passive: false });

  render();

  return Object.freeze({
    close,
    dispose() {
      resetSwipe();
      harnessValidationGate.invalidate();
      root.ownerDocument.removeEventListener("click", dismissWatcher.observe, true);
      root.ownerDocument.removeEventListener("click", outsideClick);
      root.removeEventListener("wheel", onFamilyWheel);
      trigger.onclick = null;
      root.onkeydown = null;
      root.querySelectorAll("[data-model-picker-tab]").forEach((tab) => { tab.onclick = null; });
    },
    getSelection: () => selectionReady() ? { ...currentSelection } : null,
    isReady: selectionReady,
    modelSetup: () => selectionReady() ? null : modelPickerModelSetup(currentSettings, currentSelection),
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
      resetSwipe();
      harnessValidationGate.invalidate();
      validatingHarness = false;
      const recoveringFamilyId = selectionReady()
        ? null
        : modelPickerModelSetup(currentSettings, currentSelection)?.familyId ?? null;
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
      // A refresh that ends the selected family's recovery can restore it with another roster.
      // The family is kept, and its first available model replaces one it no longer has, as when
      // the thread is first opened (PROV-008).
      if (
        recoveringFamilyId != null
        && currentSettings
        && !selectionReady()
        && String(currentSelection?.familyId) === String(recoveringFamilyId)
        && !modelPickerModelSetup(currentSettings, currentSelection)
      ) {
        const restored = resolveUnsentModelIntent(currentSettings, {
          ...currentSelection,
          harnessId: selectedHarnessId(),
        });
        if (restored.selection) currentSelection = restored.selection;
      }
      error = null;
      render();
      onSelectionChange(selectionReady() ? currentSelection : null);
    },
  });
}
