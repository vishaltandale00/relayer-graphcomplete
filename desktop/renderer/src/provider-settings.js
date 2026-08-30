import { refreshNewThreadModelPicker } from "./composer-model-picker.js";
import { refreshModelFamilySettings } from "./model-family-settings.js";
import { createProviderSettingsConnectionController } from "./provider-settings-connection.js";
import { normalizeProviderDescriptor, providerConnectionErrors, providerCreationPayload } from "./provider-ui-model.js";
import { bindRovingRadioGroup, providerConnectionFormMarkup, providerDefinitionsMarkup, providerOptionsMarkup } from "./provider-ui.js";
import { appState, desktop } from "./state.js";
import { $, $$, toast } from "./ui.js";

let status;
let selectedDescriptor;
let values;
let initialized = false;
const providerConnection = desktop?.providers ? createProviderSettingsConnectionController({
  providers: desktop.providers,
  onPending: () => dialogStatus("Complete sign-in in your browser. Relayer will continue automatically."),
}) : null;
const providerReconnect = desktop?.providers ? createProviderSettingsConnectionController({
  providers: desktop.providers,
  onPending: () => setStatus("Complete sign-in in your browser. Relayer will continue automatically."),
}) : null;

function setStatus(message = "", kind = "") {
  const element = $("#providerSettingsStatus");
  element.textContent = message;
  element.className = `model-settings-status${kind ? ` ${kind}` : ""}`;
}

function renderDefinitions() {
  $("#providerDefinitionList").innerHTML = providerDefinitionsMarkup(
    status?.definitions ?? [],
    appState.modelSettings?.defaults ?? {},
    status?.adapters ?? [],
  );
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
        setStatus(error.message, "error");
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
      try {
        const outcome = await providerReconnect?.reconnect(button.dataset.providerReconnect);
        if (!outcome || outcome.status !== "settled") return;
        await refreshProviderSettings();
        await refreshModelFamilySettings();
        refreshNewThreadModelPicker();
        setStatus("Provider reconnected.", "success");
      } catch (error) {
        setStatus(error.message, "error");
      }
    };
  });
  $$('[data-provider-family-recovery]', $("#providerDefinitionList")).forEach((button) => {
    button.onclick = async () => {
      setStatus("Refreshing provider models…");
      try {
        await desktop.models.refresh(button.dataset.providerFamilyRecovery);
        await refreshProviderSettings();
        await refreshModelFamilySettings();
        refreshNewThreadModelPicker();
        setStatus("Provider models and default family refreshed.", "success");
      } catch (error) {
        await refreshProviderSettings();
        setStatus(error.message, "error");
      }
    };
  });
  $$("[data-provider-remove]", $("#providerDefinitionList")).forEach((button) => {
    button.onclick = async () => {
      const definition = status.definitions.find((item) => item.id === button.dataset.providerRemove);
      if (!window.confirm(`Remove “${definition.label}”? This cannot be restored.`)) return;
      try {
        await desktop.providers.remove(definition.id);
        await refreshProviderSettings();
        await refreshModelFamilySettings();
        refreshNewThreadModelPicker();
        setStatus("Provider removal started.", "success");
      } catch (error) {
        setStatus(error.message, "error");
      }
    };
  });
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

function renderConnectionForm(adapterId, showErrors = false) {
  selectedDescriptor = normalizeProviderDescriptor(status.adapters.find((item) => item.adapterId === adapterId));
  values ??= { label: selectedDescriptor.label, endpoint: selectedDescriptor.defaultEndpoint, fields: {} };
  $("#providerDialogTitle").textContent = selectedDescriptor.label;
  $("#providerDialogContent").innerHTML = `${providerConnectionFormMarkup(selectedDescriptor, values, status.definitions, showErrors)}<div class="provider-setup-actions"><button type="button" class="secondary" data-provider-dialog-back>Back</button><button type="button" class="primary" data-provider-dialog-connect>Connect and discover models</button></div>`;
  $("[data-provider-dialog-back]").onclick = renderAdapterOptions;
  $("[data-provider-dialog-connect]").onclick = connect;
  requestAnimationFrame(() => $(
    showErrors ? '[aria-invalid="true"]' : "#providerField-label",
    $("#providerDialogContent"),
  )?.focus());
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
  $("#providerDialog").addEventListener("close", () => {
    providerConnection?.close();
  });
  desktop.providers.onChanged(() => void refreshProviderSettings().catch((error) => toast(error.message)));
}
