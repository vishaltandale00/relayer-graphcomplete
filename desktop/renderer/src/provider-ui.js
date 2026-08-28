import {
  providerConnectionErrors,
  providerDefinitionStatus,
  providerDescriptorGroups,
} from "./provider-ui-model.js";
import { usableHarnessPresentations } from "./harness-settings-model.js";
import { escapeHtmlAttribute } from "./ui.js";

const escapeHtml = escapeHtmlAttribute;

const PROVIDER_LOGOS = Object.freeze({
  "claude-subscription": Object.freeze({
    name: "claude",
    path: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  }),
  "anthropic-api": Object.freeze({
    name: "anthropic",
    path: "M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z",
  }),
  "codex-subscription": Object.freeze({
    name: "codex",
    path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
  }),
  "openai-api": Object.freeze({
    name: "openai",
    get path() { return PROVIDER_LOGOS["codex-subscription"].path; },
  }),
  openrouter: Object.freeze({
    name: "openrouter",
    path: "M16.778 1.844v1.919q-.569-.026-1.138-.032-.708-.008-1.415.037c-1.93.126-4.023.728-6.149 2.237-2.911 2.066-2.731 1.95-4.14 2.75-.396.223-1.342.574-2.185.798-.841.225-1.753.333-1.751.333v4.229s.768.108 1.61.333c.842.224 1.789.575 2.185.799 1.41.798 1.228.683 4.14 2.75 2.126 1.509 4.22 2.11 6.148 2.236.88.058 1.716.041 2.555.005v1.918l7.222-4.168-7.222-4.17v2.176c-.86.038-1.611.065-2.278.021-1.364-.09-2.417-.357-3.979-1.465-2.244-1.593-2.866-2.027-3.68-2.508.889-.518 1.449-.906 3.822-2.59 1.56-1.109 2.614-1.377 3.978-1.466.667-.044 1.418-.017 2.278.02v2.176L24 6.014Z",
  }),
  "vercel-ai-router": Object.freeze({ name: "vercel", path: "m12 1.608 12 20.784H0Z" }),
});

export function providerLogoMarkup(adapterId) {
  const logo = PROVIDER_LOGOS[adapterId];
  if (!logo) return `<span class="provider-icon provider-icon-generic" data-provider-logo="generic" aria-hidden="true">◇</span>`;
  return `<span class="provider-icon provider-icon-${logo.name}" data-provider-logo="${logo.name}" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="${logo.path}"></path></svg></span>`;
}

function fieldError(id, message) {
  return message
    ? `<span class="field-error" id="${escapeHtmlAttribute(id)}Error" role="alert">${escapeHtml(message)}</span>`
    : "";
}

export function providerOptionsMarkup(descriptors) {
  const groups = providerDescriptorGroups(descriptors);
  let optionIndex = 0;
  const section = (label, items) => items.length ? `<section class="provider-option-group">
    <h2>${escapeHtml(label)}</h2>
    <div class="provider-option-grid">${items.map((descriptor) => {
    const selected = optionIndex++ === 0;
    return `<button type="button" class="provider-option" role="radio" aria-checked="${selected}" tabindex="${selected ? 0 : -1}" data-provider-adapter="${escapeHtmlAttribute(descriptor.adapterId)}">
      ${providerLogoMarkup(descriptor.adapterId)}
      <span class="provider-copy"><strong>${escapeHtml(descriptor.label)}</strong><small>${descriptor.connection.mode === "secret-fields" ? "API provider" : "Subscription"}</small></span>
      <span aria-hidden="true">→</span>
    </button>`;
  }).join("")}</div>
  </section>` : "";
  return `<div class="provider-option-list" role="radiogroup" aria-label="Providers">${section("Subscriptions", groups.subscriptions)}${section("API providers", groups.api)}</div>`;
}

export function rovingRadioIndex(key, currentIndex, count) {
  if (count <= 0 || currentIndex < 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (["ArrowDown", "ArrowRight"].includes(key)) return (currentIndex + 1) % count;
  if (["ArrowUp", "ArrowLeft"].includes(key)) return (currentIndex - 1 + count) % count;
  return null;
}

export function bindRovingRadioGroup(group, { onMove, onActivate } = {}) {
  if (!group) return;
  group.onkeydown = (event) => {
    const radios = [...group.querySelectorAll('[role="radio"]:not(:disabled)')];
    const currentIndex = radios.indexOf(event.target.closest?.('[role="radio"]'));
    if (["Enter", " "].includes(event.key) && currentIndex >= 0) {
      event.preventDefault();
      onActivate ? onActivate(radios[currentIndex]) : radios[currentIndex].click?.();
      radios[currentIndex].focus();
      return;
    }
    const nextIndex = rovingRadioIndex(event.key, currentIndex, radios.length);
    if (nextIndex === null) return;
    event.preventDefault();
    radios.forEach((radio, index) => {
      const selected = index === nextIndex;
      radio.setAttribute("aria-checked", String(selected));
      radio.tabIndex = selected ? 0 : -1;
    });
    radios[nextIndex].focus();
    onMove?.(radios[nextIndex]);
  };
}

function onboardingReason(reason) {
  return reason?.message ? `<small class="onboarding-choice-reason">${escapeHtml(reason.message)}</small>` : "";
}

function familyChoice({ kind, id = "", name, summary, selected }) {
  return `<button type="button" class="onboarding-choice" role="radio" aria-checked="${selected}" tabindex="${selected ? 0 : -1}" data-onboarding-family-kind="${escapeHtmlAttribute(kind)}" ${id === "" ? "" : `data-onboarding-family-id="${escapeHtmlAttribute(id)}"`}>
    <span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(summary)}</small></span><i aria-hidden="true">${selected ? "✓" : ""}</i>
  </button>`;
}

export function onboardingFamilyOptionsMarkup(options, intent = {}) {
  const customFamilies = options?.existingCustomFamilies ?? [];
  const managedFamilies = options?.existingManagedFamilies ?? [];
  const managed = options?.managedFamilyCandidate;
  const eligibleModels = options?.eligibleModels ?? [];
  const selectedMembers = new Set((intent.members ?? []).map(({ providerId, modelId }) => `${providerId}\0${modelId}`));
  const existingChoice = (family, typeLabel) => familyChoice({
    kind: "existing",
    id: family.id,
    name: family.name,
    summary: `${typeLabel} · ${(family.members ?? []).length} model${(family.members ?? []).length === 1 ? "" : "s"}`,
    selected: intent.kind === "existing" && String(intent.familyId) === String(family.id),
  });
  const groups = [
    { label: "Existing custom families", choices: customFamilies.map((family) => existingChoice(family, "Custom family")) },
    { label: "Existing managed families", choices: managedFamilies.map((family) => existingChoice(family, "Managed family")) },
    { label: "Managed family candidate", choices: managed ? [familyChoice({
      kind: "managed",
      name: managed.name,
      summary: `Managed default · ${(managed.members ?? []).length} model${(managed.members ?? []).length === 1 ? "" : "s"}`,
      selected: intent.kind === "managed",
    })] : [] },
    { label: "New custom family", choices: eligibleModels.length ? [familyChoice({
      kind: "create",
      name: "Create a custom family",
      summary: "Choose every model explicitly",
      selected: intent.kind === "create",
    })] : [] },
  ];
  const hasSelected = groups.some(({ choices }) => choices.some((choice) => choice.includes('aria-checked="true"')));
  let assignedTabStop = hasSelected;
  const groupedChoices = groups.map(({ label, choices }) => {
    const normalized = choices.map((choice) => {
      if (assignedTabStop) return choice;
      assignedTabStop = true;
      return choice.replace('tabindex="-1"', 'tabindex="0"');
    });
    return normalized.length ? `<section class="onboarding-family-choice-section"><h4>${escapeHtml(label)}</h4>${normalized.join("")}</section>` : "";
  }).join("");
  const createFields = intent.kind === "create" ? `<div class="onboarding-custom-family" data-onboarding-custom-family>
    <label class="provider-form-field"><span>Family name</span><input id="onboardingFamilyName" value="${escapeHtmlAttribute(intent.name ?? "")}" autocomplete="off" /></label>
    <fieldset class="onboarding-model-members"><legend>Models in this family</legend>${eligibleModels.map((model) => {
      const key = `${model.providerId}\0${model.modelId}`;
      return `<label><input type="checkbox" data-onboarding-member-provider="${escapeHtmlAttribute(model.providerId)}" data-onboarding-member-model="${escapeHtmlAttribute(model.modelId)}" ${selectedMembers.has(key) ? "checked" : ""} /><span><strong>${escapeHtml(model.label)}</strong><small>${escapeHtml(model.modelId)}</small></span></label>`;
    }).join("")}</fieldset>
  </div>` : "";
  return `<div class="onboarding-choice-group" role="radiogroup" aria-label="Default model family">${groupedChoices}</div>${createFields}${onboardingReason(options?.blockingReason)}`;
}

export function providerConnectionFormMarkup(descriptor, values = {}, definitions = [], showErrors = false) {
  const fields = values.fields ?? {};
  const errors = showErrors ? providerConnectionErrors(descriptor, values, definitions) : {};
  const input = ({ id, label, kind = "text", value = "", required = true, immutable = false }) => `<label class="provider-form-field">
    <span>${escapeHtml(label)}</span>
    <input id="providerField-${escapeHtmlAttribute(id)}" data-provider-field="${escapeHtmlAttribute(id)}" type="${kind === "secret" ? "password" : "text"}" value="${escapeHtmlAttribute(value)}" ${required ? "required" : ""} ${immutable ? "readonly" : ""} aria-invalid="${Boolean(errors[id])}" ${errors[id] ? `aria-describedby="${escapeHtmlAttribute(id)}Error"` : ""} />
    ${fieldError(id, errors[id])}
  </label>`;
  return `<div class="provider-form-heading">${providerLogoMarkup(descriptor.adapterId)}<div><h2>${escapeHtml(descriptor.label)}</h2><p>${descriptor.connection.mode === "secret-fields" ? "Connect and discover available models before saving." : "Sign in to create an isolated provider connection."}</p></div></div>
    ${input({ id: "label", label: "Connection name", value: values.label ?? descriptor.label })}
    ${descriptor.endpointEditableDuringCreation ? input({ id: "endpoint", label: "Endpoint", value: values.endpoint ?? descriptor.defaultEndpoint ?? "" }) : ""}
    ${descriptor.connection.fields.map((field) => input({ ...field, value: fields[field.id] ?? "" })).join("")}`;
}

export function providerDefinitionsMarkup(definitions, defaults = {}, descriptors = []) {
  if (!definitions.length) return `<div class="family-empty">No providers connected.</div>`;
  return definitions.filter((definition) => definition.lifecycleState !== "tombstoned").map((definition) => {
    const status = providerDefinitionStatus(definition);
    const isDefault = String(defaults.providerId) === String(definition.id);
    const descriptor = descriptors.find((candidate) => candidate.adapterId === definition.adapterId);
    const canLogout = descriptor?.connection?.mode && descriptor.connection.mode !== "secret-fields";
    const canReconnect = canLogout && status.lifecycle === "unavailable";
    return `<article class="provider-definition-card ${escapeHtmlAttribute(status.lifecycle)}" data-provider-definition="${escapeHtmlAttribute(definition.id)}">
      <div class="provider-definition-heading"><div class="provider-definition-identity">${providerLogoMarkup(definition.adapterId)}<div class="provider-definition-copy"><h3>${escapeHtml(definition.label)}</h3><span>${escapeHtml(definition.adapterLabel ?? definition.adapterId)}</span></div></div><span class="provider-status ${status.usable ? "connected" : "unavailable"}">${escapeHtml(status.label)}</span></div>
      <dl><div><dt>Endpoint</dt><dd>${escapeHtml(definition.endpoint ?? "Managed by subscription")}</dd></div><div><dt>Access</dt><dd>${escapeHtml(definition.accessContract ?? "Managed")}</dd></div></dl>
      <div class="provider-definition-actions">
        ${isDefault ? `<span class="default-badge">Default provider</span>` : ""}
        <span class="push"></span>
        ${canReconnect ? `<button type="button" class="secondary" data-provider-reconnect="${escapeHtmlAttribute(definition.id)}">Reconnect</button>` : ""}
        ${canLogout && !canReconnect ? `<button type="button" class="secondary" data-provider-logout="${escapeHtmlAttribute(definition.id)}" ${status.lifecycle !== "active" ? "disabled" : ""}>Sign out</button>` : ""}
        <button type="button" class="secondary" data-provider-rename="${escapeHtmlAttribute(definition.id)}" ${status.lifecycle === "removal_pending" ? "disabled" : ""}>Rename</button>
        <button type="button" class="secondary danger-action" data-provider-remove="${escapeHtmlAttribute(definition.id)}" ${isDefault || status.lifecycle === "removal_pending" ? "disabled" : ""}>${status.lifecycle === "removal_pending" ? "Removing…" : "Remove"}</button>
      </div>
      ${isDefault ? `<p class="provider-removal-help">Change the default provider before removing this connection.</p>` : ""}
    </article>`;
  }).join("");
}

export function harnessConfigurationsMarkup(settings) {
  const presentations = usableHarnessPresentations(settings);
  if (!presentations.length) return `<div class="family-empty harness-empty"><div><strong>No harnesses are usable right now.</strong><span>Connect a provider with an eligible model.</span></div></div>`;
  return presentations.map(({ harness, isDefault }) => `<article class="harness-configuration-card" data-harness-configuration="${escapeHtmlAttribute(harness.id)}">
    <div class="provider-definition-heading"><div><h3>${escapeHtml(harness.label)}</h3></div>${isDefault ? `<span class="default-badge">Default harness</span>` : ""}</div>
  </article>`).join("");
}
