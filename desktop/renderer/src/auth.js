import {
  completeDefaultProviderOnboarding,
  completeProviderOnboarding,
  loadDefaultModelSelection,
  loadModelSettings,
  loadProviderOnboardingProjection,
} from "./model-settings-api.js";
import { defaultFamilySelectionForProvider } from "./model-picker-model.js";
import { resetNewThreadModelPicker } from "./composer-model-picker.js";
import { refreshModelFamilySettings } from "./model-family-settings.js";
import { normalizeProviderDescriptor, providerConnectionErrors, providerCreationPayload } from "./provider-ui-model.js";
import { bindRovingRadioGroup, providerConnectionFormMarkup, providerOptionsMarkup } from "./provider-ui.js";
import { appState, desktop, productApiAvailable } from "./state.js";
import { $, $$, escapeHtml, escapeHtmlAttribute } from "./ui.js";

let providerStatus;
let selectedDescriptor;
let connectionValues;
let connectedDefinition;
let onboardingModel;
let onboardingHarness;
let onboardingProjection;
let bound = false;
let pendingConnectionId = null;

function setStatus(message = "", kind = "") {
  const status = $("#authStatus");
  status.textContent = message;
  status.className = `auth-status${kind ? ` ${kind}` : ""}`;
}

function setBusy(busy) {
  $(".provider-setup-card")?.setAttribute("aria-busy", String(Boolean(busy)));
  $("#connectProvider").disabled = Boolean(busy);
  $("#finishProviderSetup").disabled = Boolean(busy) || !onboardingModel;
  $("#providerFamilyBack").disabled = Boolean(busy);
}

function currentFormValues() {
  const values = connectionValues ?? { label: selectedDescriptor.label, endpoint: selectedDescriptor.defaultEndpoint, fields: {} };
  for (const input of $$("[data-provider-field]", $("#providerSetupFields"))) {
    if (input.dataset.providerField === "label") values.label = input.value;
    else if (input.dataset.providerField === "endpoint") values.endpoint = input.value;
    else values.fields[input.dataset.providerField] = input.value;
  }
  return values;
}

function showProviderOptions() {
  selectedDescriptor = null;
  connectionValues = null;
  $("#providerSetupOptions").classList.remove("hidden");
  $("#providerSetupForm").classList.add("hidden");
  $("#providerFamilyStep").classList.add("hidden");
  $("#providerSetupOptions").innerHTML = providerOptionsMarkup(providerStatus?.adapters ?? []);
  $$("[data-provider-adapter]", $("#providerSetupOptions")).forEach((button) => {
    button.onclick = () => showProviderForm(button.dataset.providerAdapter);
  });
  bindRovingRadioGroup($("#providerSetupOptions").querySelector('[role="radiogroup"]'));
  setStatus(providerStatus?.definitions?.length
    ? "Add another working provider or finish setting the default family."
    : "A working provider and default model family are required to continue.");
}

function showProviderForm(adapterId, { showErrors = false } = {}) {
  selectedDescriptor = normalizeProviderDescriptor(
    providerStatus.adapters.find((descriptor) => descriptor.adapterId === adapterId),
  );
  connectionValues ??= { label: selectedDescriptor.label, endpoint: selectedDescriptor.defaultEndpoint, fields: {} };
  $("#providerSetupOptions").classList.add("hidden");
  $("#providerFamilyStep").classList.add("hidden");
  $("#providerSetupForm").classList.remove("hidden");
  $("#providerSetupFields").innerHTML = providerConnectionFormMarkup(
    selectedDescriptor,
    connectionValues,
    providerStatus.definitions,
    showErrors,
  );
  requestAnimationFrame(() => $(
    showErrors ? '[aria-invalid="true"]' : "#providerField-label",
    $("#providerSetupFields"),
  )?.focus());
}

async function completeOnboarding() {
  if (productApiAvailable) {
    await refreshModelFamilySettings();
    resetNewThreadModelPicker();
    await loadDefaultModelSelection(appState.modelSettings.defaults.harnessId);
  }
  await desktop.providers.completeOnboarding();
  showApplication();
}

async function prepareFamilyStep(definition) {
  if (!productApiAvailable) return completeOnboarding();
  const settings = await loadModelSettings();
  if (defaultFamilySelectionForProvider(settings, settings.defaults.harnessId, definition.id)) {
    return completeOnboarding();
  }
  const declaredDefault = await completeDefaultProviderOnboarding(definition.id);
  if (declaredDefault) return completeOnboarding();
  const provider = settings.providers.find((item) => String(item.id) === String(definition.id));
  onboardingProjection = await loadProviderOnboardingProjection(definition.id);
  const appDefault = onboardingProjection.harnesses.find((harness) => harness.isAppDefault);
  onboardingHarness = appDefault?.id ?? null;
  const renderChoices = () => {
    const selectedHarness = onboardingProjection.harnesses.find(({ id }) => id === onboardingHarness);
    const models = selectedHarness?.models ?? [];
    if (!models.some(({ id }) => id === onboardingModel)) onboardingModel = null;
    const harnessTabStopId = onboardingHarness ?? onboardingProjection.harnesses[0]?.id;
    const modelTabStopId = onboardingModel ?? models[0]?.id;
    $("#onboardingFamilyOptions").innerHTML = `
      <div class="provider-form-field"><span>Harness</span><div class="onboarding-model-list" role="radiogroup" aria-label="Default harness">
        ${onboardingProjection.harnesses.map((harness) => `<button type="button" role="radio" aria-checked="${harness.id === onboardingHarness}" tabindex="${harness.id === harnessTabStopId ? 0 : -1}" data-onboarding-harness="${escapeHtmlAttribute(harness.id)}"><span><strong>${escapeHtml(harness.label)}</strong><small>${harness.isAppDefault ? "Relayer app default" : "Compatible harness"}</small></span><i aria-hidden="true">${harness.id === onboardingHarness ? "✓" : ""}</i></button>`).join("") || `<p class="field-error" role="alert">No available harness can use this provider.</p>`}
      </div></div>
      ${selectedHarness ? `<div class="provider-form-field"><span>Model</span><div class="onboarding-model-list" role="radiogroup" aria-label="Default model">
        ${models.map((model) => `<button type="button" role="radio" aria-checked="${model.id === onboardingModel}" tabindex="${model.id === modelTabStopId ? 0 : -1}" data-onboarding-model="${escapeHtmlAttribute(model.id)}"><span><strong>${escapeHtml(model.label)}</strong><small>${escapeHtml(provider.label)}</small></span><i aria-hidden="true">${model.id === onboardingModel ? "✓" : ""}</i></button>`).join("")}
      </div></div>` : ""}
    `;
    $$("[data-onboarding-harness]", $("#onboardingFamilyOptions")).forEach((button) => {
      button.onclick = () => {
        onboardingHarness = button.dataset.onboardingHarness;
        onboardingModel = null;
        renderChoices();
        requestAnimationFrame(() => $(`[data-onboarding-harness="${CSS.escape(onboardingHarness)}"]`)?.focus());
      };
    });
    bindRovingRadioGroup($("#onboardingFamilyOptions").querySelector('[aria-label="Default harness"]'), {
      onMove: (button) => {
        onboardingHarness = button.dataset.onboardingHarness;
        onboardingModel = null;
        renderChoices();
        requestAnimationFrame(() => $(`[data-onboarding-harness="${CSS.escape(onboardingHarness)}"]`)?.focus());
      },
    });
    $$("[data-onboarding-model]", $("#onboardingFamilyOptions")).forEach((button) => {
      button.onclick = () => {
        onboardingModel = button.dataset.onboardingModel;
        renderChoices();
        requestAnimationFrame(() => $(`[data-onboarding-model="${CSS.escape(onboardingModel)}"]`)?.focus());
      };
    });
    bindRovingRadioGroup($("#onboardingFamilyOptions").querySelector('[aria-label="Default model"]'), {
      onMove: (button) => {
        onboardingModel = button.dataset.onboardingModel;
        renderChoices();
        requestAnimationFrame(() => $(`[data-onboarding-model="${CSS.escape(onboardingModel)}"]`)?.focus());
      },
    });
    $("#finishProviderSetup").disabled = !onboardingModel;
  };
  const models = (provider?.models ?? []).filter((model) => model.visible !== false && model.available !== false);
  if (!models.length) throw new Error("The connected provider has no available models.");
  onboardingModel = null;
  $("#providerSetupOptions").classList.add("hidden");
  $("#providerSetupForm").classList.add("hidden");
  $("#providerFamilyStep").classList.remove("hidden");
  renderChoices();
  setStatus(onboardingProjection.harnesses.length
    ? "Choose a compatible harness and model. Relayer will not choose a model for you."
    : `${provider.label} is connected, but no available harness can use its models. Connect another provider to continue.`,
  onboardingProjection.harnesses.length ? "" : "error");
}

async function connectSelectedProvider(event) {
  event?.preventDefault();
  if (!selectedDescriptor || !desktop?.providers) return;
  connectionValues = currentFormValues();
  const errors = providerConnectionErrors(selectedDescriptor, connectionValues, providerStatus.definitions);
  if (Object.keys(errors).length) return showProviderForm(selectedDescriptor.adapterId, { showErrors: true });
  setBusy(true);
  setStatus(`Preparing ${selectedDescriptor.label} runtime and connecting…`);
  const connectionId = crypto.randomUUID().toLowerCase();
  pendingConnectionId = connectionId;
  try {
    let result = await desktop.providers.connect(providerCreationPayload(
      selectedDescriptor,
      connectionValues,
      { connectionId },
    ));
    if (pendingConnectionId !== connectionId) return;
    pendingConnectionId = result.status === "pending" ? result.connectionId : null;
    while (result.status === "pending" && pendingConnectionId === result.connectionId) {
      setStatus("Complete sign-in in your browser. Relayer will continue automatically.");
      await new Promise((resolve) => setTimeout(resolve, 750));
      if (pendingConnectionId !== result.connectionId) return;
      result = await desktop.providers.completeConnection(result.connectionId);
    }
    if (result.status !== "connected") return;
    pendingConnectionId = null;
    connectedDefinition = result.providerDefinition;
    providerStatus = await desktop.providers.status();
    await prepareFamilyStep(connectedDefinition);
  } catch (error) {
    if (pendingConnectionId !== connectionId && error.message === "Provider connection was cancelled.") return;
    pendingConnectionId = null;
    setStatus(error.message, "error");
    showProviderForm(selectedDescriptor.adapterId);
  } finally {
    setBusy(false);
  }
}

function bindProviderSetup() {
  if (bound) return;
  bound = true;
  $("#providerSetupForm").onsubmit = connectSelectedProvider;
  $("#providerSetupBack").onclick = showProviderOptions;
  $("#providerFamilyBack").onclick = async () => {
    providerStatus = await desktop.providers.status();
    connectedDefinition = null;
    onboardingModel = null;
    onboardingProjection = null;
    showProviderOptions();
  };
  $("#cancelProviderConnection").onclick = async () => {
    const connectionId = pendingConnectionId;
    pendingConnectionId = null;
    if (connectionId) await desktop.providers.cancelConnection(connectionId).catch(() => {});
    setBusy(false);
    showProviderOptions();
  };
  $("#finishProviderSetup").onclick = async () => {
    if (!connectedDefinition || !onboardingModel) return;
    setBusy(true);
    try {
      await completeProviderOnboarding({
        providerId: connectedDefinition.id,
        harnessId: onboardingHarness,
        familyName: `${connectedDefinition.label} default`,
        modelId: onboardingModel,
      });
      await completeOnboarding();
    } catch (error) {
      setStatus(error.message, "error");
    } finally {
      setBusy(false);
    }
  };
}

export function showApplication() {
  $("#authScreen").classList.add("hidden");
  $("#appShell").classList.remove("hidden");
}

export function showAuth(message = "") {
  $("#appShell").classList.add("hidden");
  $("#authScreen").classList.remove("hidden");
  if (message) setStatus(message, "error");
}

export async function refreshAccount() {
  if (!desktop) {
    showApplication();
    return { status: "connected" };
  }
  bindProviderSetup();
  providerStatus = await desktop.providers?.status?.();
  if (providerStatus) {
    if (providerStatus.hasCompletedOnboarding) {
      showApplication();
      const account = await desktop.account?.read?.().catch(() => null);
      if (account?.status === "connected") {
        const label = account.account?.email || "Codex connected";
        const settingsAccount = $("#settingsAccount");
        if (settingsAccount) {
          settingsAccount.textContent = account.account?.planType
            ? `${label} · ${account.account.planType}`
            : label;
        }
      }
      return { status: "connected", providerStatus, account: account?.account };
    }
    showAuth();
    showProviderOptions();
    return { status: "disconnected", providerStatus };
  }
  const result = await desktop.account.read();
  if (result.status === "connected") {
    showApplication();
    const label = result.account?.email || "Codex connected";
    const settingsAccount = $("#settingsAccount");
    if (settingsAccount) {
      settingsAccount.textContent = result.account?.planType
        ? `${label} · ${result.account.planType}`
        : label;
    }
    return result;
  }
  showAuth(result.error || "Provider setup is unavailable.");
  return result;
}

export async function connectCodex() {
  if (providerStatus?.adapters?.some(({ adapterId }) => adapterId === "codex-subscription")) {
    showProviderForm("codex-subscription");
  }
}
