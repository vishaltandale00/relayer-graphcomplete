import {
  providerConnectionErrors,
  providerDefinitionStatus,
  providerDescriptorGroups,
} from "./provider-ui-model.js";
import { escapeHtmlAttribute } from "./ui.js";

const escapeHtml = escapeHtmlAttribute;

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
      <span class="provider-icon" aria-hidden="true">${descriptor.connection.mode === "secret-fields" ? "◇" : "›_"}</span>
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

export function bindRovingRadioGroup(group, { onMove } = {}) {
  if (!group) return;
  group.onkeydown = (event) => {
    const radios = [...group.querySelectorAll('[role="radio"]:not(:disabled)')];
    const currentIndex = radios.indexOf(event.target.closest?.('[role="radio"]'));
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

export function providerConnectionFormMarkup(descriptor, values = {}, definitions = [], showErrors = false) {
  const fields = values.fields ?? {};
  const errors = showErrors ? providerConnectionErrors(descriptor, values, definitions) : {};
  const input = ({ id, label, kind = "text", value = "", required = true, immutable = false }) => `<label class="provider-form-field">
    <span>${escapeHtml(label)}</span>
    <input id="providerField-${escapeHtmlAttribute(id)}" data-provider-field="${escapeHtmlAttribute(id)}" type="${kind === "secret" ? "password" : "text"}" value="${escapeHtmlAttribute(value)}" ${required ? "required" : ""} ${immutable ? "readonly" : ""} aria-invalid="${Boolean(errors[id])}" ${errors[id] ? `aria-describedby="${escapeHtmlAttribute(id)}Error"` : ""} />
    ${fieldError(id, errors[id])}
  </label>`;
  return `<div class="provider-form-heading"><span class="provider-icon" aria-hidden="true">${descriptor.connection.mode === "secret-fields" ? "◇" : "›_"}</span><div><h2>${escapeHtml(descriptor.label)}</h2><p>${descriptor.connection.mode === "secret-fields" ? "Connect and discover available models before saving." : "Sign in to create an isolated provider connection."}</p></div></div>
    ${input({ id: "label", label: "Provider name", value: values.label ?? descriptor.label })}
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
    return `<article class="provider-definition-card ${escapeHtmlAttribute(status.lifecycle)}" data-provider-definition="${escapeHtmlAttribute(definition.id)}">
      <div class="provider-definition-heading"><div><h3>${escapeHtml(definition.label)}</h3><span>${escapeHtml(definition.adapterLabel ?? definition.adapterId)}</span></div><span class="provider-status ${status.usable ? "connected" : "unavailable"}">${escapeHtml(status.label)}</span></div>
      <dl><div><dt>Endpoint</dt><dd>${escapeHtml(definition.endpoint ?? "Managed by subscription")}</dd></div><div><dt>Access</dt><dd>${escapeHtml(definition.accessContract ?? "Managed")}</dd></div></dl>
      <div class="provider-definition-actions">
        ${isDefault ? `<span class="default-badge">Default provider</span>` : ""}
        <span class="push"></span>
        ${canLogout ? `<button type="button" class="secondary" data-provider-logout="${escapeHtmlAttribute(definition.id)}" ${status.lifecycle !== "active" ? "disabled" : ""}>Sign out</button>` : ""}
        <button type="button" class="secondary" data-provider-rename="${escapeHtmlAttribute(definition.id)}" ${status.lifecycle === "removal_pending" ? "disabled" : ""}>Rename</button>
        <button type="button" class="secondary danger-action" data-provider-remove="${escapeHtmlAttribute(definition.id)}" ${isDefault || status.lifecycle === "removal_pending" ? "disabled" : ""}>${status.lifecycle === "removal_pending" ? "Removing…" : "Remove"}</button>
      </div>
      ${isDefault ? `<p class="provider-removal-help">Change the default provider before removing this connection.</p>` : ""}
    </article>`;
  }).join("");
}

function ruleLabel(rule) {
  const matcher = rule.modelIdExact ? `is ${rule.modelIdExact}` : `matches ${rule.modelIdRegex}`;
  return `${rule.adapterId} · ${matcher}`;
}

export function harnessConfigurationsMarkup(harnesses) {
  if (!harnesses.length) return `<div class="family-empty">No harness configurations available.</div>`;
  return harnesses.map((harness) => `<article class="harness-configuration-card" data-harness-configuration="${escapeHtmlAttribute(harness.id)}">
    <div class="provider-definition-heading"><div><h3>${escapeHtml(harness.label)}</h3><span>${escapeHtml(harness.id)}</span></div><span class="provider-status ${harness.available === false ? "unavailable" : "connected"}">${harness.available === false ? "Unavailable" : "Available"}</span></div>
    <dl><div><dt>Execution access</dt><dd>${escapeHtml((harness.executionAccessContracts ?? []).join(", ") || "Configuration managed")}</dd></div><div><dt>Revision</dt><dd>${escapeHtml(harness.configurationRevision ?? harness.revision ?? "Current")}</dd></div></dl>
    <div class="harness-rule-groups">
      <section><h4>Allow</h4>${(harness.modelRules?.allow ?? []).length ? `<ul>${harness.modelRules.allow.map((rule) => `<li>${escapeHtml(ruleLabel(rule))}</li>`).join("")}</ul>` : `<p>All models not denied</p>`}</section>
      <section><h4>Deny</h4>${(harness.modelRules?.deny ?? []).length ? `<ul>${harness.modelRules.deny.map((rule) => `<li>${escapeHtml(ruleLabel(rule))}</li>`).join("")}</ul>` : `<p>No deny rules</p>`}</section>
    </div>
    <div class="provider-definition-actions"><span class="push"></span><button type="button" class="secondary" data-harness-rules-edit="${escapeHtmlAttribute(harness.id)}">Edit model rules</button></div>
  </article>`).join("");
}
