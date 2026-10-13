import { harnessConfigurationsMarkup } from "./provider-ui.js";
import { refreshProviderModels } from "./provider-models-refresh.js";
import { appState } from "./state.js";
import { $, toast } from "./ui.js";

const repairing = new Set();

export function renderHarnessSettings(settings = appState.modelSettings) {
  const target = $("#harnessConfigurationList");
  if (!target) return;
  const focusedHarness = target.contains(document.activeElement) ? document.activeElement?.dataset.harnessRepair : null;
  target.innerHTML = harnessConfigurationsMarkup(settings);
  for (const button of target.querySelectorAll("[data-harness-repair]")) {
    const harnessId = button.dataset.harnessRepair;
    button.setAttribute("aria-disabled", String(repairing.has(harnessId)));
    button.setAttribute("aria-busy", String(repairing.has(harnessId)));
    button.onclick = async () => {
      if (repairing.has(harnessId)) return;
      repairing.add(harnessId);
      // Keep the native activation target in place through the keyboard/click event.
      button.setAttribute("aria-disabled", "true");
      button.setAttribute("aria-busy", "true");
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
  if (focusedHarness) {
    const replacement = [...target.querySelectorAll("[data-harness-repair]")].find(button => button.dataset.harnessRepair === focusedHarness);
    if (replacement) replacement.focus({ preventScroll: true });
    else { target.tabIndex = -1; target.focus({ preventScroll: true }); }
  }
}
