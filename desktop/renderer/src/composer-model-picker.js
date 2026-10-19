import { createModelPicker } from "./model-picker.js";
import { providerModelsRefreshAction } from "./provider-models-refresh.js";
import { pickerSelectionPayload } from "./model-picker-model.js";
import { validateModelSelection } from "./model-settings-api.js";
import { preparePermissionProfiles } from "./permission-profiles.js";
import { appState } from "./state.js";
import { $ } from "./ui.js";

let newThreadPicker;

export function initializeNewThreadModelPicker({
  onUserTakeover = () => {},
  onSelectionChange = () => {},
  onOpenSettings = () => {},
} = {}) {
  newThreadPicker ??= createModelPicker({
    root: $("#newModelControl"),
    mode: "new",
    settings: appState.modelSettings,
    onUserTakeover,
    onSelectionChange,
    onOpenSettings,
    onRefreshModels: providerModelsRefreshAction(),
    prepareHarnessChange: preparePermissionProfiles,
    validateSelection: (selection) => validateModelSelection({
      harnessId: selection.harnessId,
      familyId: selection.familyId,
      providerId: selection.providerId,
      modelId: selection.modelId,
    }),
  });
  return newThreadPicker;
}

export function closeNewThreadModelPicker() {
  newThreadPicker?.close();
}

export function newThreadModelSelectionReady() {
  return Boolean(newThreadPicker?.isReady());
}

export function newThreadModelSetup() {
  return newThreadPicker?.modelSetup() ?? null;
}

export function newThreadModelSelectionPayload() {
  return newThreadPicker?.isReady()
    ? pickerSelectionPayload(newThreadPicker.getSelection())
    : null;
}

export function openNewThreadModelPicker() {
  newThreadPicker?.open();
}

export function resetNewThreadModelPicker() {
  newThreadPicker?.setContext({
    settings: appState.modelSettings,
    pinnedHarnessId: null,
    selection: null,
    replaceSelection: true,
  });
}

export function refreshNewThreadModelPicker() {
  newThreadPicker?.setContext({ settings: appState.modelSettings });
}

export function setNewThreadModelPickerDisabled(disabled) {
  newThreadPicker?.setDisabled(disabled);
}
