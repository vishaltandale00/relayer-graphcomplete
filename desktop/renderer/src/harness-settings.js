import { harnessConfigurationsMarkup } from "./provider-ui.js";
import { refreshProviderModels } from "./provider-models-refresh.js";
import { appState } from "./state.js";
import { $, toast } from "./ui.js";

const repairing = new Set();

export function renderHarnessSettings(settings = appState.modelSettings) {
  const target = $("#harnessConfigurationList");
  if (!target) return;
  target.innerHTML = harnessConfigurationsMarkup(settings);
  for (const button of target.querySelectorAll("[data-harness-repair]")) {
    const harnessId = button.dataset.harnessRepair;
    button.disabled = repairing.has(harnessId);
    button.setAttribute("aria-busy", String(button.disabled));
    button.onclick = async () => {
      if (repairing.has(harnessId)) return;
      repairing.add(harnessId);
      renderHarnessSettings();
      try {
        await refreshProviderModels(button.dataset.repairProvider);
        const harness = appState.modelSettings?.harnesses?.find(({ id }) => id === harnessId);
        if (harness?.available !== true) {
          throw new Error(harness?.unavailableReason?.message ?? "Harness setup is still unavailable.");
        }
        toast(`${harness.label} repaired.`);
      } catch (error) {
        toast(error.message);
      } finally {
        repairing.delete(harnessId);
        renderHarnessSettings();
      }
    };
  }
}
