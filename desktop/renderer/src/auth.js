import {
  completeDefaultProviderOnboarding,
  completeProviderOnboarding,
  loadProviderOnboardingProjection,
} from "./model-settings-api.js";
import { normalizeProviderDescriptor, providerConnectionErrors, providerCreationPayload } from "./provider-ui-model.js";
import { createProviderConnectionAttemptController } from "./provider-connection-attempt.js";
import {
  providerOnboardingCompletionIntent,
  providerOnboardingRecoveryAction,
  createProviderOnboardingProjectionGate,
  reconcileProviderOnboardingState,
  resolveProviderOnboardingStep,
  resumableProviderDefinitions,
  setProviderOnboardingControlsBusy,
} from "./provider-onboarding-model.js";
import {
  bindRovingRadioGroup,
  onboardingFamilyOptionsMarkup,
  onboardingHarnessOptionsMarkup,
  providerConnectionFormMarkup,
  providerOptionsMarkup,
} from "./provider-ui.js";
import { desktop, productApiAvailable } from "./state.js";
import { $, $$, escapeHtml, escapeHtmlAttribute } from "./ui.js";

let providerStatus;
let selectedDescriptor;
let connectionValues;
let connectedDefinition;
let onboardingHarness;
let onboardingFamilyIntent;
let onboardingProjection;
const onboardingModelSearchByProvider = new Map();
const onboardingProjectionGate = createProviderOnboardingProjectionGate();
let bound = false;
let refreshProductAfterOnboarding = async () => {};

const providerConnection = desktop?.providers ? createProviderConnectionAttemptController({
  providers: desktop.providers,
  onPending: () => setStatus("Complete sign-in in your browser. Relayer will continue automatically."),
  onStateChange: (attempt) => {
    if (attempt.phase === "starting") {
      setBusy(true);
      setStatus(`Preparing ${selectedDescriptor.label} runtime and connecting…`);
    }
    if (attempt.phase === "waiting_for_sign_in") {
      setStatus("Complete sign-in in your browser. Relayer will continue automatically.");
    }
  },
}) : null;

export function setProviderOnboardingCompletionHandler(handler) {
  if (typeof handler !== "function") throw new TypeError("Provider onboarding completion handler must be a function.");
  refreshProductAfterOnboarding = handler;
}

function setStatus(message = "", kind = "") {
  const status = $("#authStatus");
  status.textContent = message;
  status.className = `auth-status${kind ? ` ${kind}` : ""}`;
  status.setAttribute("role", kind === "error" ? "alert" : "status");
}

function setBusy(busy) {
  const card = $(".provider-setup-card");
  card?.setAttribute("aria-busy", String(Boolean(busy)));
  setProviderOnboardingControlsBusy(
    $$("button,input,select,textarea", card).filter((control) => control.id !== "cancelProviderConnection"),
    busy,
  );
}

function setConnectionCancellationAvailable(available) {
  const cancel = $("#cancelProviderConnection");
  if (cancel) cancel.disabled = !available;
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
  setConnectionCancellationAvailable(true);
  selectedDescriptor = null;
  connectionValues = null;
  $("#providerSetupOptions").classList.remove("hidden");
  $("#providerSetupForm").classList.add("hidden");
  $("#providerFamilyStep").classList.add("hidden");
  const resumable = resumableProviderDefinitions(providerStatus);
  $("#providerSetupOptions").innerHTML = `${resumable.map((definition) => `<div class="connected-provider-resume"><strong>${escapeHtml(definition.label)}</strong><small>Connected and ready for harness and family setup.</small><button type="button" class="primary" data-resume-provider-onboarding="${escapeHtmlAttribute(definition.id)}">Continue setup</button></div>`).join("")}${providerOptionsMarkup(providerStatus?.adapters ?? [])}`;
  $$('[data-resume-provider-onboarding]', $("#providerSetupOptions")).forEach((button) => {
    button.addEventListener("click", () => {
      connectedDefinition = resumable.find(({ id }) => String(id) === button.dataset.resumeProviderOnboarding) ?? null;
      if (connectedDefinition) prepareFamilyStep(connectedDefinition, { preserveIntent: true }).catch((error) => setStatus(error.message, "error"));
    });
  });
  $$("[data-provider-adapter]", $("#providerSetupOptions")).forEach((button) => {
    button.onclick = () => showProviderForm(button.dataset.providerAdapter);
  });
  bindRovingRadioGroup($("#providerSetupOptions").querySelector('[role="radiogroup"]'));
  setStatus(providerStatus?.definitions?.length
    ? "Add another working provider or finish setting the default family."
    : "A working provider and default model family are required to continue.");
}

function showProviderForm(adapterId, { showErrors = false } = {}) {
  setConnectionCancellationAvailable(true);
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
  await desktop.providers.completeOnboarding();
  await refreshProductAfterOnboarding();
  showApplication();
}

function chosenHarness() {
  return onboardingProjection?.harnesses?.find(({ id }) => id === onboardingHarness) ?? null;
}

function finishIntentValid() {
  return Boolean(chosenHarness()?.selectable && providerOnboardingCompletionIntent({
    providerId: connectedDefinition?.id,
    projection: onboardingProjection,
    harnessId: onboardingHarness,
    family: onboardingFamilyIntent,
  }));
}

function focusRequiredOnboardingChoice() {
  let target;
  if (!onboardingHarness) target = $("#onboardingHarnessOptions [role=radio]:not(:disabled)");
  else if (!onboardingFamilyIntent) target = $("#onboardingFamilyOptions [role=radio]");
  else if (onboardingFamilyIntent.kind === "create" && !onboardingFamilyIntent.name?.trim()) target = $("#onboardingFamilyName");
  else if (onboardingFamilyIntent.kind === "create" && !onboardingFamilyIntent.members?.length) target = $(".onboarding-model-members input");
  (target ?? $("#authStatus"))?.focus();
}

function selectFamily(button) {
  const harness = chosenHarness();
  if (!harness) return;
  const kind = button.dataset.onboardingFamilyKind;
  if (kind === "existing") {
    const family = [...(harness.existingCustomFamilies ?? []), ...(harness.existingManagedFamilies ?? [])]
      .find(({ id }) => String(id) === button.dataset.onboardingFamilyId);
    if (!family) return;
    onboardingFamilyIntent = { kind, familyId: family.id };
  } else if (kind === "managed" && harness.managedFamilyCandidate) {
    onboardingFamilyIntent = {
      kind,
      policyId: harness.managedFamilyCandidate.policyId,
      policyVersion: harness.managedFamilyCandidate.policyVersion,
    };
  } else if (kind === "create") {
    onboardingFamilyIntent = {
      kind,
      name: onboardingFamilyIntent?.kind === "create"
        ? onboardingFamilyIntent.name
        : `${connectedDefinition.label} default`,
      members: onboardingFamilyIntent?.kind === "create" ? onboardingFamilyIntent.members : [],
    };
  } else return;
  renderOnboardingChoices({ focus: "family" });
}

function bindOnboardingChoices({ focus } = {}) {
  const harnessGroup = $("#onboardingHarnessOptions [role=radiogroup]");
  const chooseHarness = (button) => {
    const nextHarness = button.dataset.onboardingHarness;
    if (nextHarness !== onboardingHarness) onboardingFamilyIntent = null;
    onboardingHarness = nextHarness;
    renderOnboardingChoices({ focus: "harness" });
  };
  $$('[data-onboarding-harness]:not(:disabled)', harnessGroup).forEach((button) => { button.onclick = () => chooseHarness(button); });
  bindRovingRadioGroup(harnessGroup, { onMove: chooseHarness, onActivate: chooseHarness });

  const familyGroup = $("#onboardingFamilyOptions [role=radiogroup]");
  if (familyGroup) $$('[data-onboarding-family-kind]', familyGroup).forEach((button) => { button.onclick = () => selectFamily(button); });
  bindRovingRadioGroup(familyGroup, { onMove: selectFamily, onActivate: selectFamily });
  $("#onboardingFamilyName")?.addEventListener("input", (event) => {
    onboardingFamilyIntent.name = event.target.value;
    $("#finishProviderSetup").disabled = !finishIntentValid();
  });
  $("[data-onboarding-model-search]")?.addEventListener("input", (event) => {
    onboardingModelSearchByProvider.set(connectedDefinition.id, event.target.value);
    renderOnboardingChoices({ focus: "model-search" });
  });
  $("[data-onboarding-model-search-clear]")?.addEventListener("click", () => {
    onboardingModelSearchByProvider.set(connectedDefinition.id, "");
    renderOnboardingChoices({ focus: "model-search" });
  });
  $$('[data-onboarding-member-model]', $("#onboardingFamilyOptions")).forEach((input) => {
    input.onchange = () => {
      const member = { providerId: input.dataset.onboardingMemberProvider, modelId: input.dataset.onboardingMemberModel };
      const key = ({ providerId, modelId }) => `${providerId}\0${modelId}`;
      onboardingFamilyIntent.members = input.checked
        ? [...onboardingFamilyIntent.members.filter((value) => key(value) !== key(member)), member]
        : onboardingFamilyIntent.members.filter((value) => key(value) !== key(member));
      $("#finishProviderSetup").disabled = !finishIntentValid();
    };
  });
  if (focus === "harness" || focus === "family") {
    requestAnimationFrame(() => $(`#onboarding${focus === "harness" ? "Harness" : "Family"}Options [aria-checked=true]`)?.focus());
  }
}

function renderOnboardingChoices({ focus } = {}) {
  $("#onboardingHarnessOptions").innerHTML = onboardingHarnessOptionsMarkup(onboardingProjection, onboardingHarness);
  const harness = chosenHarness();
  $("#onboardingFamilyOptions").innerHTML = harness
    ? onboardingFamilyOptionsMarkup(harness, onboardingFamilyIntent ?? {}, {
      modelSearch: onboardingModelSearchByProvider.get(connectedDefinition.id) ?? "",
    })
    : `<p class="field-error" role="alert">${onboardingProjection.blockingReason?.message ?? "Choose a compatible harness to continue."}</p>`;
  $("#finishProviderSetup").disabled = !finishIntentValid();
  const recovery = providerOnboardingRecoveryAction(onboardingProjection);
  const recoveryButton = $("#refreshOnboardingProviderModels");
  recoveryButton.classList.toggle("hidden", recovery === null);
  recoveryButton.textContent = recovery?.label ?? "Refresh models and set up defaults";
  bindOnboardingChoices({ focus });
  if (focus === "model-search") requestAnimationFrame(() => {
    const search = $("[data-onboarding-model-search]");
    search?.focus();
    search?.setSelectionRange(search.value.length, search.value.length);
  });
}

async function prepareFamilyStep(definition, { preserveIntent = false } = {}) {
  if (!productApiAvailable) return completeOnboarding();
  const providerId = definition.id;
  const request = onboardingProjectionGate.begin(providerId);
  const step = await resolveProviderOnboardingStep({
    gate: onboardingProjectionGate,
    request,
    providerId,
    activeProviderId: () => connectedDefinition?.id,
    preserveIntent,
    completeDefault: completeDefaultProviderOnboarding,
    loadProjection: loadProviderOnboardingProjection,
  });
  if (step.kind === "stale") return;
  if (step.kind === "complete") return completeOnboarding();
  const previous = preserveIntent ? { harnessId: onboardingHarness, family: onboardingFamilyIntent } : null;
  onboardingProjection = step.projection;
  const reconciled = reconcileProviderOnboardingState(onboardingProjection, previous);
  onboardingHarness = reconciled.harnessId;
  onboardingFamilyIntent = reconciled.family;
  $("#providerSetupOptions").classList.add("hidden");
  $("#providerSetupForm").classList.add("hidden");
  $("#providerFamilyStep").classList.remove("hidden");
  const hasCompatibleHarness = onboardingProjection.harnesses.some((harness) => harness.selectable);
  $("#providerFamilyBack").textContent = hasCompatibleHarness ? "← All providers" : "← Connect another provider";
  renderOnboardingChoices();
  setStatus(onboardingProjection.blockingReason?.message
    ?? "Choose a compatible harness and explicitly confirm a default family.");
}

async function connectSelectedProvider(event) {
  event?.preventDefault();
  if (!selectedDescriptor || !providerConnection) return;
  connectionValues = currentFormValues();
  const errors = providerConnectionErrors(selectedDescriptor, connectionValues, providerStatus.definitions);
  if (Object.keys(errors).length) return showProviderForm(selectedDescriptor.adapterId, { showErrors: true });
  try {
    const outcome = await providerConnection.connect(providerCreationPayload(
      selectedDescriptor,
      connectionValues,
    ));
    if (outcome.status !== "settled") return;
    const { result } = outcome;
    if (result.status !== "connected") return;
    // Provider state has committed. Cancel no longer has a reversible operation
    // to target, so do not accept it while defaults and product state refresh.
    setConnectionCancellationAvailable(false);
    connectedDefinition = result.providerDefinition;
    providerStatus = await desktop.providers.status();
    await prepareFamilyStep(connectedDefinition);
  } catch (error) {
    if (!providerConnection.current() && error.message === "Provider connection was cancelled.") return;
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
  $("#providerFamilyBack").onclick = showProviderOptions;
  $("#cancelProviderConnection").onclick = async () => {
    if (!providerConnection?.current()) {
      setBusy(false);
      showProviderOptions();
      return;
    }
    const result = await providerConnection.close();
    if (result.error) {
      setStatus("Relayer could not confirm cancellation. The provider connection is still running.", "error");
      return;
    }
    if (!result.cancelled) {
      setConnectionCancellationAvailable(false);
      setStatus("Provider connection is finishing and can no longer be cancelled.");
      return;
    }
    setBusy(false);
    showProviderOptions();
  };
  $("#finishProviderSetup").onclick = async () => {
    if (!connectedDefinition || !finishIntentValid()) {
      setStatus("Choose a compatible harness and default family before continuing.", "error");
      focusRequiredOnboardingChoice();
      return;
    }
    setBusy(true);
    let blockingError = null;
    try {
      const intent = providerOnboardingCompletionIntent({
        providerId: connectedDefinition.id,
        projection: onboardingProjection,
        harnessId: onboardingHarness,
        family: onboardingFamilyIntent,
      });
      await completeProviderOnboarding(intent);
      await completeOnboarding();
    } catch (error) {
      blockingError = error;
      await prepareFamilyStep(connectedDefinition, { preserveIntent: true }).catch(() => {});
      setStatus(error.message, "error");
    } finally {
      setBusy(false);
    }
    if (blockingError) focusRequiredOnboardingChoice();
  };
  $("#refreshOnboardingProviderModels").onclick = async () => {
    const providerId = onboardingProjection?.provider?.id;
    if (!providerId) return;
    setBusy(true);
    try {
      await desktop.models.refresh(providerId);
      providerStatus = await desktop.providers.status();
      const refreshedDefinition = providerStatus.definitions.find(({ id }) => String(id) === String(providerId));
      if (!refreshedDefinition) throw new Error("The refreshed provider is no longer available.");
      connectedDefinition = refreshedDefinition;
      await prepareFamilyStep(refreshedDefinition);
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
      return { status: "connected", providerStatus };
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
