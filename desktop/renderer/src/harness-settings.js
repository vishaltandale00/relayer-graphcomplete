import { appState } from "./state.js";
import { saveHarnessModelRules } from "./model-settings-api.js";
import { harnessConfigurationsMarkup } from "./provider-ui.js";
import { authoritativeRefreshConfirmed, validateHarnessRules } from "./harness-settings-model.js";
import { $, $$, escapeHtml, escapeHtmlAttribute } from "./ui.js";

let edit = null;
let saving = false;
let advanced = false;
let eligibilityRefreshFailed = false;

function status(message = "", kind = "") {
  const target = $("#harnessSettingsStatus");
  if (!target) return;
  target.textContent = message;
  target.className = `model-settings-status${kind ? ` ${kind}` : ""}`;
  target.setAttribute("role", kind === "error" ? "alert" : "status");
}

function matcher(rule) {
  return rule.modelIdRegex !== undefined ? "regex" : "exact";
}

function pattern(rule) {
  return rule.modelIdRegex ?? rule.modelIdExact ?? "";
}

function revision(harness) {
  return harness.configurationRevision ?? harness.revision;
}

function ruleEditor(effect, rule, index, errors) {
  const key = `${effect}.${index}`;
  const type = matcher(rule);
  const adapterErrorId = `harnessRule-${effect}-${index}-adapterError`;
  const patternErrorId = `harnessRule-${effect}-${index}-patternError`;
  return `<div class="harness-rule-editor" data-harness-rule="${effect}.${index}">
    <label><span>Adapter</span><input data-harness-rule-adapter="${effect}.${index}" value="${escapeHtmlAttribute(rule.adapterId ?? "")}" aria-invalid="${Boolean(errors[`${key}.adapterId`])}" ${errors[`${key}.adapterId`] ? `aria-describedby="${adapterErrorId}"` : ""} ${saving ? "disabled" : ""} /></label>
    <label><span>Match</span><select data-harness-rule-kind="${effect}.${index}" ${saving ? "disabled" : ""}><option value="exact" ${type === "exact" ? "selected" : ""}>Exact</option><option value="regex" ${type === "regex" ? "selected" : ""}>Regex</option></select></label>
    <label class="harness-rule-pattern"><span>${type === "exact" ? "Model ID" : "Model regex"}</span><input data-harness-rule-pattern="${effect}.${index}" value="${escapeHtmlAttribute(pattern(rule))}" aria-invalid="${Boolean(errors[`${key}.pattern`])}" ${errors[`${key}.pattern`] ? `aria-describedby="${patternErrorId}"` : ""} ${saving ? "disabled" : ""} /></label>
    <button type="button" class="icon-button" data-harness-rule-remove="${effect}.${index}" aria-label="Remove ${effect} rule ${index + 1}" ${saving ? "disabled" : ""}>×</button>
    ${errors[`${key}.adapterId`] ? `<span class="field-error" id="${adapterErrorId}" role="alert">${escapeHtml(errors[`${key}.adapterId`])}</span>` : ""}
    ${errors[`${key}.pattern`] ? `<span class="field-error harness-rule-error" id="${patternErrorId}" role="alert">${escapeHtml(errors[`${key}.pattern`])}</span>` : ""}
  </div>`;
}

function editorMarkup(harness) {
  const errors = edit.errors ?? {};
  const group = (effect, empty) => `<section><div class="harness-rule-editor-heading"><h4>${effect === "allow" ? "Allow" : "Deny"}</h4><button type="button" class="secondary" data-harness-rule-add="${effect}" ${saving ? "disabled" : ""}>＋ Add rule</button></div>${edit.rules[effect].length ? edit.rules[effect].map((rule, index) => ruleEditor(effect, rule, index, errors)).join("") : `<p>${empty}</p>`}</section>`;
  return `<article class="harness-configuration-card harness-rules-editor-card" aria-busy="${saving}">
    <div class="provider-definition-heading"><div><h3 id="harnessAdvancedEditorHeading" tabindex="-1">${escapeHtml(harness.label)} advanced configuration</h3></div></div>
    <p class="harness-rules-help">Rules match adapter ID plus model ID. Deny always wins; an empty Allow list permits every model not denied.</p>
    <div class="harness-rule-editor-groups">${group("allow", "All models not denied")}${group("deny", "No deny rules")}</div>
    ${errors.form ? `<div class="field-error" role="alert">${escapeHtml(errors.form)}</div>` : ""}
    <div class="provider-definition-actions"><button type="button" class="secondary" id="cancelHarnessRules" ${saving ? "disabled" : ""}>Cancel</button><span class="push"></span><button type="button" class="primary" id="saveHarnessRules" ${saving ? "disabled" : ""}>${saving ? "Saving…" : "Save rules"}</button></div>
  </article>`;
}

function advancedMarkup(harnesses) {
  const editable = harnesses.filter((harness) => harness.available !== false);
  return `<section class="harness-advanced-panel" aria-labelledby="harnessAdvancedHeading">
    <div class="provider-definition-heading"><div><h3 id="harnessAdvancedHeading" tabindex="-1">Advanced configuration</h3><span>Edit model eligibility rules for an installed harness.</span></div></div>
    <div class="harness-advanced-options">${editable.length ? editable.map((harness) => `<button type="button" class="secondary" data-harness-advanced-edit="${escapeHtmlAttribute(harness.id)}">${escapeHtml(harness.label)}</button>`).join("") : `<p>No installed harness rules can be edited.</p>`}</div>
    <div class="provider-definition-actions"><button type="button" class="secondary" id="closeHarnessAdvanced">Back to harnesses</button></div>
  </section>`;
}

function focusAfterRender(selector) {
  requestAnimationFrame(() => $(selector)?.focus());
}

async function retryEligibilityRefresh() {
  try {
    const { refreshModelSettings } = await import("./model-family-settings.js");
    const previousSettings = appState.modelSettings;
    const applied = await refreshModelSettings();
    const refreshed = authoritativeRefreshConfirmed(
      previousSettings,
      appState.modelSettings,
      applied,
    );
    if (refreshed) return status();
  } catch {}
  eligibilityRefreshFailed = true;
  status("Current harness eligibility could not be refreshed.", "error");
  renderHarnessSettings();
  focusAfterRender("#retryHarnessEligibility");
}

function beginEditing(selected, returnToAdvanced = false) {
  edit = {
    harnessId: selected.id,
    rules: structuredClone(selected.modelRules ?? { allow: [], deny: [] }),
    errors: {},
    returnToAdvanced,
  };
  status();
  renderHarnessSettings();
  focusAfterRender("#harnessAdvancedEditorHeading");
}

function setRuleValue(path, field, value) {
  const [effect, rawIndex] = path.split(".");
  const rule = edit.rules[effect][Number(rawIndex)];
  if (field === "adapterId") rule.adapterId = value;
  if (field === "pattern") {
    if (matcher(rule) === "regex") rule.modelIdRegex = value;
    else rule.modelIdExact = value;
  }
  edit.errors = {};
}

function bindEditor(harness) {
  $$('[data-harness-rule-adapter]').forEach((input) => { input.oninput = () => setRuleValue(input.dataset.harnessRuleAdapter, "adapterId", input.value); });
  $$('[data-harness-rule-pattern]').forEach((input) => { input.oninput = () => setRuleValue(input.dataset.harnessRulePattern, "pattern", input.value); });
  $$('[data-harness-rule-kind]').forEach((select) => {
    select.onchange = () => {
      const [effect, rawIndex] = select.dataset.harnessRuleKind.split(".");
      const rule = edit.rules[effect][Number(rawIndex)];
      const value = pattern(rule);
      delete rule.modelIdExact;
      delete rule.modelIdRegex;
      rule[select.value === "regex" ? "modelIdRegex" : "modelIdExact"] = value;
      renderHarnessSettings();
    };
  });
  $$('[data-harness-rule-remove]').forEach((button) => {
    button.onclick = () => {
      const [effect, rawIndex] = button.dataset.harnessRuleRemove.split(".");
      edit.rules[effect].splice(Number(rawIndex), 1);
      edit.errors = {};
      renderHarnessSettings();
    };
  });
  $$('[data-harness-rule-add]').forEach((button) => {
    button.onclick = () => {
      edit.rules[button.dataset.harnessRuleAdd].push({ adapterId: "", modelIdExact: "" });
      edit.errors = {};
      renderHarnessSettings();
      requestAnimationFrame(() => $$('[data-harness-rule-adapter]').at(-1)?.focus());
    };
  });
  $("#cancelHarnessRules").onclick = () => {
    const harnessId = edit.harnessId;
    const returnToAdvanced = edit.returnToAdvanced;
    edit = null;
    advanced = returnToAdvanced;
    status();
    renderHarnessSettings();
    focusAfterRender(returnToAdvanced ? "#harnessAdvancedHeading" : `[data-harness-rules-edit="${harnessId}"]`);
  };
  $("#saveHarnessRules").onclick = async () => {
    edit.errors = validateHarnessRules(edit.rules);
    if (Object.keys(edit.errors).length) {
      renderHarnessSettings();
      requestAnimationFrame(() => $('[aria-invalid="true"]')?.focus());
      return;
    }
    const submittedRules = structuredClone(edit.rules);
    let savedHarnessId = null;
    let refreshed = false;
    saving = true;
    renderHarnessSettings();
    try {
      await saveHarnessModelRules(harness.id, { expectedRevision: revision(harness), ...submittedRules });
      harness.modelRules = submittedRules;
      harness.configurationRevision = revision(harness) + 1;
      edit = null;
      advanced = false;
      savedHarnessId = harness.id;
      eligibilityRefreshFailed = false;
      status("Harness model rules saved.", "success");
      try {
        const { refreshModelSettings } = await import("./model-family-settings.js");
        const previousSettings = appState.modelSettings;
        const applied = await refreshModelSettings();
        refreshed = authoritativeRefreshConfirmed(
          previousSettings,
          appState.modelSettings,
          applied,
        );
        if (!refreshed) {
          eligibilityRefreshFailed = true;
          status("Harness model rules saved, but current eligibility could not be confirmed.", "error");
        }
      } catch {
        eligibilityRefreshFailed = true;
        status("Harness model rules saved, but current eligibility could not be refreshed.", "error");
      }
    } catch (error) {
      status(error.message, "error");
    } finally {
      saving = false;
      if (!refreshed) renderHarnessSettings();
      if (savedHarnessId) {
        focusAfterRender(`#retryHarnessEligibility, [data-harness-rules-edit="${savedHarnessId}"], #openHarnessAdvanced`);
      }
    }
  };
}

export function markHarnessEligibilityCurrent() {
  eligibilityRefreshFailed = false;
}

export function renderHarnessSettings(settings = appState.modelSettings) {
  const target = $("#harnessConfigurationList");
  if (!target) return;
  const harnesses = settings?.harnesses ?? [];
  const harness = edit && harnesses.find((candidate) => candidate.id === edit.harnessId);
  if (!harness && eligibilityRefreshFailed) {
    target.innerHTML = `<div class="family-empty harness-empty" role="alert"><div><strong>Harness availability needs to be refreshed.</strong><span>Reload the current provider and model eligibility before choosing a harness.</span><button type="button" class="secondary" id="retryHarnessEligibility">Refresh harnesses</button></div></div>`;
    $("#retryHarnessEligibility").onclick = retryEligibilityRefresh;
    return;
  }
  target.innerHTML = harness
    ? editorMarkup(harness)
    : advanced
      ? advancedMarkup(harnesses)
      : harnessConfigurationsMarkup(settings);
  if (harness) return bindEditor(harness);
  if (advanced) {
    $$('[data-harness-advanced-edit]').forEach((button) => {
      button.onclick = () => beginEditing(
        harnesses.find((candidate) => candidate.id === button.dataset.harnessAdvancedEdit),
        true,
      );
    });
    $("#closeHarnessAdvanced").onclick = () => {
      advanced = false;
      renderHarnessSettings(settings);
      focusAfterRender("#openHarnessAdvanced");
    };
    return;
  }
  $$('[data-harness-rules-edit]').forEach((button) => {
    button.onclick = () => {
      const selected = harnesses.find((candidate) => candidate.id === button.dataset.harnessRulesEdit);
      beginEditing(selected);
    };
  });
  const openAdvanced = $("#openHarnessAdvanced");
  if (openAdvanced) {
    openAdvanced.onclick = () => {
      advanced = true;
      renderHarnessSettings(settings);
      focusAfterRender("#harnessAdvancedHeading");
    };
  }
}
