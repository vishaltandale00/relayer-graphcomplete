export function selectionForAblation(catalog, ablationId) {
  const ablation = catalog.ablations?.find(({ id }) => id === ablationId);
  if (!ablation) throw new Error(`Unknown Eval ablation: ${ablationId}`);
  return {
    testCaseIds: [...ablation.testCaseIds],
    harnessConfigurationNames: ablation.harnessPairs.flatMap(({ control, treatment }) => [control, treatment]),
    judgeConfigurationName: catalog.judges.some(({ id }) => id === "deterministic-graph-contract")
      ? "deterministic-graph-contract"
      : catalog.judges[0]?.id,
  };
}

export function bindAblationControls(root, catalog, onApplied = () => {}) {
  root.querySelectorAll("[data-ablation]").forEach((button) => {
    button.onclick = () => onApplied(applyAblationToControls(root, catalog, button.dataset.ablation));
  });
}

export function applyAblationToControls(root, catalog, ablationId) {
  const selection = selectionForAblation(catalog, ablationId);
  const selected = {
    cases: new Set(selection.testCaseIds),
    harnesses: new Set(selection.harnessConfigurationNames),
    judge: new Set([selection.judgeConfigurationName]),
  };
  for (const group of Object.keys(selected)) {
    root.querySelectorAll(`input[name="${group}"]`).forEach((input) => {
      input.checked = selected[group].has(input.value);
    });
  }
  return selection;
}

export function selectionFromControls(root) {
  const values = (name) => [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
  return {
    testCaseIds: values("cases"),
    harnessConfigurationNames: values("harnesses"),
    judgeConfigurationName: values("judge")[0],
  };
}

export function createRunFromControls(root, api) {
  return api.createRun(selectionFromControls(root));
}
