import { createBrandLockup, spreadOnHover } from "/src/relayer-mark.js";

// Initialize before importing production state, which captures its desktop bridge.
// This entry point is selected by the settings server, not by a URL query flag.
window.initializeRelayerEvalSettings();
const [
  { initializeProviderSettings },
  { initializeModelFamilySettings, refreshModelFamilySettings },
  { loadModelSettings, saveModelDefaults },
  { setMainView, setSettingsTab },
] = await Promise.all([
  import("/src/provider-settings.js"),
  import("/src/model-family-settings.js"),
  import("/src/model-settings-api.js"),
  import("/src/navigation.js"),
]);

const tabs = new Set(["providers", "models", "harnesses"]);
document.title = "Relayer Eval · Provider and model setup";
document.body.classList.remove("desktop-account-pending");
document.querySelector("#authScreen")?.classList.add("hidden");
document.querySelector("#appShell").classList.remove("hidden");
document.querySelector(".sidebar-title strong").textContent = "Eval";
// The shared shell draws the wordmark lockups itself; this entry point replaces main.js, so it
// must initialise them too or the empty SVGs fall back to their 300x150 intrinsic size.
for (const [id, height] of [["brandLockup", 24], ["heroLockup", 40]]) {
  const svg = document.getElementById(id);
  if (svg) spreadOnHover(svg, createBrandLockup(svg, { height, reducedMotion: () => matchMedia("(prefers-reduced-motion: reduce)").matches }));
}
for (const button of document.querySelectorAll("[data-settings-tab]")) {
  if (!tabs.has(button.dataset.settingsTab)) button.remove();
  else button.onclick = () => setSettingsTab(button.dataset.settingsTab);
}
const compact = document.querySelector("#settingsCompactSelect");
for (const option of [...compact.options]) if (!tabs.has(option.value)) option.remove();
compact.onchange = () => setSettingsTab(compact.value);
for (const id of ["settingsBackButton", "settingsCompactBackButton"]) {
  const button = document.getElementById(id);
  if (button) {
    button.textContent = "Back to Eval";
    button.setAttribute("aria-label", "Back to Eval");
    button.onclick = () => {
      const destination = window.relayerEvalSettings.returnTo;
      if (destination) window.location.assign(destination);
      else showError(new Error("Open Settings from the Eval dashboard to enable the return link. You can also switch back to your existing Eval dashboard tab."));
    };
  }
}
setMainView("settings");
setSettingsTab("providers");
const note = document.createElement("p");
note.className = "model-settings-status";
note.textContent = "Configure providers and models here, then use Back to Eval to start a test run or a Human Grader task. Finish active sessions and runs before changing settings.";
document.querySelector("#settingsTitle").after(note);
const familyRow = document.createElement("label");
familyRow.className = "setting-row";
familyRow.innerHTML = '<b>Eval model family</b><select id="evalDefaultFamilySelect" disabled></select><small>Eval uses the first available model compatible with the selected harness. Reorder a family to change model priority.</small>';
document.querySelector(".model-defaults").append(familyRow);
const familySelect = familyRow.querySelector("select");
let familyRefresh = 0;
let savingFamily = false;
async function refreshDefaultFamily() {
  const request = ++familyRefresh;
  const settings = await loadModelSettings();
  if (request !== familyRefresh) return;
  familySelect.replaceChildren();
  for (const family of settings.families) {
    const option = new Option(family.name, String(family.id));
    option.disabled = !family.enabled;
    familySelect.add(option);
  }
  familySelect.value = String(settings.defaults.familyId ?? "");
  familySelect.disabled = savingFamily || !settings.families.some((family) => family.enabled);
}
const showError = (error) => { note.textContent = error.message; note.classList.add("error"); };
familySelect.onchange = async () => {
  savingFamily = true;
  familySelect.disabled = true;
  try {
    await saveModelDefaults({ familyId: Number(familySelect.value) });
    await refreshModelFamilySettings();
  } catch (error) { showError(error); }
  finally { savingFamily = false; await refreshDefaultFamily().catch(showError); }
};
window.addEventListener("relayer-eval-model-settings-changed", () => void refreshDefaultFamily().catch(showError));
const connectionButtons = ["newProviderDefinition", "refreshProviderCatalogs"].map((id) => document.getElementById(id));
for (const button of connectionButtons) button.disabled = true;
try {
  await window.relayerDesktop.models.settingsOpened();
  await initializeModelFamilySettings();
  await initializeProviderSettings();
  await refreshDefaultFamily();
  for (const button of connectionButtons) button.disabled = false;
  window.relayerDesktop.providers.onChanged(() => {
    void refreshModelFamilySettings().catch(showError);
    void refreshDefaultFamily().catch(showError);
  });
} catch (error) {
  note.textContent = error.message;
  note.classList.add("error");
}
window.lucide?.createIcons();
