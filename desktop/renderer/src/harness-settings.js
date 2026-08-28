import { harnessConfigurationsMarkup } from "./provider-ui.js";
import { appState } from "./state.js";
import { $ } from "./ui.js";

export function renderHarnessSettings(settings = appState.modelSettings) {
  const target = $("#harnessConfigurationList");
  if (!target) return;
  target.innerHTML = harnessConfigurationsMarkup(settings);
}
