import { refreshNewThreadModelPicker } from "./composer-model-picker.js";
import { refreshModelFamilySettings } from "./model-family-settings.js";
import { bindProviderConnectionDialogCancellation, createProviderConnectionAttemptController } from "./provider-connection-attempt.js";
import { normalizeProviderDescriptor, providerConnectionErrors, providerCreationPayload, providerEditErrors, providerEditPayload, providerFamilyRecoveryResult, providerRemovalConsequences } from "./provider-ui-model.js";
import { bindRovingRadioGroup, providerConnectionActionsMarkup, providerConnectionFormMarkup, providerDefinitionsMarkup, providerEditConnectionFormMarkup, providerOptionsMarkup } from "./provider-ui.js";
import { appState, desktop } from "./state.js";
import { $, $$, escapeHtml, toast } from "./ui.js";

let status;
let selectedDescriptor;
let values;
let editingDefinition = null;
let initialized = false;
const checkingProviders = new Set();
const providerConnection = desktop?.providers ? createProviderConnectionAttemptController({
  providers: desktop.providers,
  onPending: () => dialogStatus("Complete sign-in in your browser. Relayer will continue automatically."),
  onStateChange: (attempt) => {
    if (!selectedDescriptor || editingDefinition) return;
    renderConnectionForm(selectedDescriptor.adapterId, false, attempt, { focusStatus: true });
    if (attempt.phase === "starting") dialogStatus(`Preparing ${selectedDescriptor.label} runtime and connecting…`);
    if (attempt.phase === "waiting_for_sign_in") dialogStatus("Complete sign-in in your browser. Relayer will continue automatically.");
  },
}) : null;
const providerReconnect = desktop?.providers ? createProviderConnectionAttemptController({
  providers: desktop.providers,
  onPending: () => setStatus("Complete sign-in in your browser. Relayer will continue automatically."),
  onStateChange: (attempt) => {
    const focusedCard = document.activeElement?.closest?.("[data-provider-definition]");
    renderDefinitions(attempt.connectionId ?? focusedCard?.dataset.providerDefinition ?? null);
    if (attempt.phase === "starting") setStatus("Preparing provider runtime and reconnecting…");
    if (attempt.phase === "waiting_for_sign_in") setStatus("Complete sign-in in your browser. Relayer will continue automatically.");
  },
}) : null;

function setStatus(message = "", kind = "") {
  const element = $("#providerSettingsStatus");
  element.textContent = message;
  element.className = `model-settings-status${kind ? ` ${kind}` : ""}`;
}

function focusProviderSettingsStatus() {
  const element = $("#providerSettingsStatus");
  element.tabIndex = -1;
  element.focus({ preventScroll: true });
}

function renderDefinitions(focusProviderId = null) {
  $("#providerDefinitionList").innerHTML = providerDefinitionsMarkup(
    status?.definitions ?? [],
    appState.modelSettings?.defaults ?? {},
    status?.adapters ?? [],
    providerReconnect?.state(),
  );
  $$(".provider-warning-trigger", $("#providerDefinitionList")).forEach((button) => {
    button.onclick = () => {
      const warning = button.closest(".provider-warning");
      const open = !warning.classList.contains("open");
      $$(".provider-warning.open", $("#providerDefinitionList")).forEach((item) => item.classList.remove("open"));
      warning.classList.toggle("open", open);
      button.setAttribute("aria-expanded", String(open));
    };
    button.onkeydown = (event) => {
      if (event.key !== "Escape") return;
      button.closest(".provider-warning").classList.remove("open");
      button.setAttribute("aria-expanded", "false");
    };
  });
  for (const providerId of checkingProviders) {
    const card = $$('[data-provider-definition]', $("#providerDefinitionList")).find((item) => item.dataset.providerDefinition === providerId);
    if (!card) continue;
    $$("button", card).forEach((item) => { item.disabled = true; });
    const retry = $("[data-provider-retry]", card);
    if (retry) retry.textContent = "Checking…";
  }
  $$("[data-provider-rename]", $("#providerDefinitionList")).forEach((button) => {
    button.onclick = async () => {
      const definition = status.definitions.find((item) => item.id === button.dataset.providerRename);
      const label = window.prompt("Connection name", definition.label)?.trim();
      if (!label || label === definition.label) return;
      try {
        await desktop.providers.rename(definition.id, label);
        await refreshProviderSettings();
        setStatus("Provider renamed.", "success");
      } catch (error) {
        setStatus("Connection check could not be completed.", "error");
      }
    };
  });
  $$('[data-provider-logout]', $("#providerDefinitionList")).forEach((button) => {
    button.onclick = async () => {
      try {
        await desktop.providers.logout(button.dataset.providerLogout);
        await refreshProviderSettings();
        await refreshModelFamilySettings();
        refreshNewThreadModelPicker();
        setStatus("Provider signed out.", "success");
      } catch (error) {
        setStatus(error.message, "error");
      }
    };
  });
  $$('[data-provider-reconnect]', $("#providerDefinitionList")).forEach((button) => {
    button.onclick = async () => {
      const providerId = button.dataset.providerReconnect;
      try {
        const outcome = await providerReconnect?.reconnect(providerId);
        if (!outcome || outcome.status !== "settled") return;
        await refreshProviderSettings();
        await refreshModelFamilySettings();
        refreshNewThreadModelPicker();
        setStatus("Provider reconnected.", "success");
        focusProviderSettingsStatus();
      } catch (error) {
        setStatus(error.message, "error");
      }
    };
  });
  $$('[data-provider-retry]', $("#providerDefinitionList")).forEach((button) => {
    button.onclick = async () => {
      const id = button.dataset.providerRetry;
      if (checkingProviders.has(id)) return;
      checkingProviders.add(id);
      renderDefinitions();
      try {
        await desktop.providers.retry(id);
        await refreshProviderSettings();
        await refreshModelFamilySettings();
        refreshNewThreadModelPicker();
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        checkingProviders.delete(id);
        renderDefinitions();
      }
    };
  });
  $$('[data-provider-edit]', $("#providerDefinitionList")).forEach((button) => {
    button.onclick = () => renderEditConnection(button.dataset.providerEdit);
  });
  $$('[data-provider-family-recovery]', $("#providerDefinitionList")).forEach((button) => {
    button.onclick = async () => {
      const providerId = button.dataset.providerFamilyRecovery;
      setStatus("Refreshing provider models…");
      try {
        await desktop.models.refresh(providerId);
        await refreshProviderSettings();
        await refreshModelFamilySettings();
        refreshNewThreadModelPicker();
        const recovery = providerFamilyRecoveryResult(status, providerId);
        setStatus(recovery.message, recovery.recovered ? "success" : "");
      } catch (error) {
        await refreshProviderSettings();
        setStatus(error.message, "error");
      }
    };
  });
  $$("[data-provider-remove]", $("#providerDefinitionList")).forEach((button) => {
    button.onclick = () => {
      const definition = status.definitions.find((item) => item.id === button.dataset.providerRemove);
      renderRemovalConfirmation(definition);
    };
  });
  if (focusProviderId) {
    $$('[data-provider-definition]', $("#providerDefinitionList"))
      .find((card) => card.dataset.providerDefinition === focusProviderId)
      ?.focus({ preventScroll: true });
  }
}

function renderRemovalConfirmation(definition) {
  const consequences = providerRemovalConsequences(definition, appState.modelSettings);
  $("#providerDialogTitle").textContent = "Remove connection";
  const group = (title, names) => names.length ? `<section><h3>${title}</h3><ul>${names.map((name) => `<li>${escapeHtml(name)}</li>`).join("")}</ul></section>` : "";
  $("#providerDialogContent").innerHTML = `<p>New chats lose access immediately. Active chats may finish. Removal cannot be cancelled or restored.</p><div class="provider-removal-consequences">${group("Will be deleted", consequences.deleted)}${group("Will be updated", consequences.updated)}<section><h3>Will remain active until current chats finish</h3><ul><li>${escapeHtml(definition.label)}</li></ul></section></div>${consequences.blocked ? `<p class="field-error">Choose another default model family first.</p>` : ""}<div class="provider-setup-actions"><button type="button" class="secondary" data-provider-remove-cancel>Cancel</button><button type="button" class="primary danger-action" data-provider-remove-confirm ${consequences.blocked ? "disabled" : ""}>Remove connection</button></div>`;
  $("[data-provider-remove-cancel]").onclick = () => $("#providerDialog").close();
  $("[data-provider-remove-confirm]").onclick = async () => {
    try {
      await desktop.providers.remove(definition.id);
      $("#providerDialog").close();
      await refreshProviderSettings();
      await refreshModelFamilySettings();
      refreshNewThreadModelPicker();
      setStatus("Provider removal started.", "success");
    } catch (error) {
      dialogStatus("Removal could not be completed. Try again.", "error");
    }
  };
  $("#providerDialog").showModal();
}

function dialogStatus(message = "", kind = "") {
  const element = $("#providerDialogStatus");
  element.textContent = message;
  element.className = `auth-status${kind ? ` ${kind}` : ""}`;
}

function readValues() {
  for (const input of $$("[data-provider-field]", $("#providerDialogContent"))) {
    if (input.dataset.providerField === "label") values.label = input.value;
    else if (input.dataset.providerField === "endpoint") values.endpoint = input.value;
    else values.fields[input.dataset.providerField] = input.value;
  }
  return values;
}

function renderAdapterOptions() {
  editingDefinition = null;
  selectedDescriptor = null;
  values = null;
  $("#providerDialogTitle").textContent = "Add provider";
  $("#providerDialogContent").innerHTML = providerOptionsMarkup(status.adapters);
  dialogStatus("Choose an independent provider connection.");
  $$("[data-provider-adapter]", $("#providerDialogContent")).forEach((button) => {
    button.onclick = (event) => {
      event.preventDefault();
      renderConnectionForm(button.dataset.providerAdapter);
    };
  });
  bindRovingRadioGroup($("#providerDialogContent").querySelector('[role="radiogroup"]'));
}

function renderEditConnection(id, errors = {}) {
  editingDefinition = status.definitions.find((definition) => definition.id === id);
  selectedDescriptor = normalizeProviderDescriptor(status.adapters.find((item) => item.adapterId === editingDefinition.adapterId));
  values = Object.keys(errors).length && values ? values : {
    endpoint: editingDefinition.endpoint ?? selectedDescriptor.defaultEndpoint,
    fields: {},
  };
  $("#providerDialogTitle").textContent = "Edit connection";
  $("#providerDialogContent").innerHTML = `${providerEditConnectionFormMarkup(selectedDescriptor, editingDefinition, values, errors)}<div class="provider-setup-actions"><button type="button" class="secondary" data-provider-dialog-cancel>Cancel</button><button type="button" class="primary" data-provider-dialog-save>Validate and save</button></div>`;
  $("[data-provider-dialog-cancel]").onclick = () => $("#providerDialog").close();
  $("[data-provider-dialog-save]").onclick = validateAndSaveEdit;
  if (!$("#providerDialog").open) $("#providerDialog").showModal();
}

async function validateAndSaveEdit() {
  readValues();
  const errors = providerEditErrors(selectedDescriptor, values);
  if (Object.keys(errors).length) return renderEditConnection(editingDefinition.id, errors);
  dialogStatus("Validating connection and models…");
  try {
    await desktop.providers.edit(editingDefinition.id, providerEditPayload(selectedDescriptor, values));
    $("#providerDialog").close();
    await refreshProviderSettings();
    await refreshModelFamilySettings();
    refreshNewThreadModelPicker();
    setStatus("Connection updated.", "success");
  } catch (error) {
    dialogStatus("Connection could not be validated. Check the endpoint or replacement credential.", "error");
  }
}

function renderConnectionForm(
  adapterId,
  showErrors = false,
  connectionAttempt = providerConnection?.state(),
  { focusStatus = false } = {},
) {
  selectedDescriptor = normalizeProviderDescriptor(status.adapters.find((item) => item.adapterId === adapterId));
  values ??= { label: selectedDescriptor.label, endpoint: selectedDescriptor.defaultEndpoint, fields: {} };
  $("#providerDialogTitle").textContent = selectedDescriptor.label;
  $("#providerDialogContent").innerHTML = `${providerConnectionFormMarkup(selectedDescriptor, values, status.definitions, showErrors)}${providerConnectionActionsMarkup(connectionAttempt)}`;
  $("[data-provider-dialog-back]").onclick = renderAdapterOptions;
  $("[data-provider-dialog-connect]").onclick = connect;
  requestAnimationFrame(() => {
    if (focusStatus) {
      const statusElement = $("#providerDialogStatus");
      statusElement.tabIndex = -1;
      statusElement.focus({ preventScroll: true });
      return;
    }
    $(showErrors ? '[aria-invalid="true"]' : "#providerField-label", $("#providerDialogContent"))?.focus();
  });
}

async function connect() {
  if (!providerConnection || providerConnection.current()) return;
  readValues();
  const errors = providerConnectionErrors(selectedDescriptor, values, status.definitions);
  if (Object.keys(errors).length) return renderConnectionForm(selectedDescriptor.adapterId, true);
  dialogStatus(`Preparing ${selectedDescriptor.label} runtime and connecting…`);
  try {
    const outcome = await providerConnection.connect(providerCreationPayload(
      selectedDescriptor,
      values,
    ));
    if (outcome.status !== "settled") return;
    const { result } = outcome;
    if (result.status !== "connected") return;
    $("#providerDialog").close();
    await refreshProviderSettings();
    await refreshModelFamilySettings();
    refreshNewThreadModelPicker();
    setStatus("Provider connected.", "success");
  } catch (error) {
    if (error.message === "Provider connection was cancelled.") return;
    dialogStatus(error.message, "error");
  }
}

export async function refreshProviderSettings() {
  if (!desktop?.providers) return;
  status = await desktop.providers.status();
  renderDefinitions();
}

export async function initializeProviderSettings() {
  if (!desktop?.providers) return;
  await refreshProviderSettings();
  if (initialized) return;
  initialized = true;
  document.addEventListener("click", (event) => {
    if (event.target.closest?.(".provider-warning")) return;
    $$(".provider-warning.open", $("#providerDefinitionList")).forEach((item) => {
      item.classList.remove("open");
      item.querySelector(".provider-warning-trigger")?.setAttribute("aria-expanded", "false");
    });
  });
  $("#refreshProviderCatalogs").onclick = async () => {
    setStatus("Refreshing provider models…");
    try {
      await desktop.models.refresh();
      await refreshProviderSettings();
      await refreshModelFamilySettings();
      refreshNewThreadModelPicker();
      setStatus("Provider models refreshed.", "success");
    } catch (error) {
      await refreshProviderSettings();
      setStatus(error.message, "error");
    }
  };
  $("#newProviderDefinition").onclick = () => {
    renderAdapterOptions();
    $("#providerDialog").showModal();
  };
  bindProviderConnectionDialogCancellation({
    dialog: $("#providerDialog"),
    controller: providerConnection,
    showStatus: dialogStatus,
  });
  desktop.providers.onChanged(() => void refreshProviderSettings().catch((error) => toast(error.message)));
}
