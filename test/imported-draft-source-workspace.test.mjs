import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/inert-draft-sources.json", import.meta.url), "utf8"));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it.each(fixtures)("reads two distinct frozen draft sources after native parent $parentStatus and local import", async fixture => {
  vi.resetModules();
  const state = structuredClone(fixture.state);
  const thread = state.threads.find(thread => thread.imported);
  const calls = state.importedInvocationHistory;
  const originalInteractions = structuredClone(state.interactions);
  const frozenRecords = structuredClone(calls.map(call => call.record));
  const restoredSource = `source:${calls[0].record.id}`;
  const window = new Window({ url: `http://127.0.0.1:3000/?threadId=${thread.id}&interactionId=${encodeURIComponent(restoredSource)}` });
  vi.stubGlobal("window", window); vi.stubGlobal("document", window.document);
  vi.stubGlobal("location", window.location); vi.stubGlobal("history", window.history);
  vi.stubGlobal("lucide", new Proxy({ Circle: {}, createElement: () => window.document.createElement("svg") }, { get: (target, key) => target[key] ?? {} }));
  window.document.body.innerHTML = '<section id="threadView"></section><div id="toast"></div>';
  vi.doMock("../desktop/renderer/src/navigation.js", () => ({ setMainView: vi.fn(), setSettingsTab: vi.fn(), renderScopeMenu: vi.fn(), renderSidebar: vi.fn() }));
  vi.doMock("../desktop/renderer/src/onboarding-tutorial.js", () => ({ onboardingTutorialController: () => null }));
  const request = vi.fn(async (path, options) => {
    if (options?.method && options.method !== "GET") throw new Error(`Unexpected mutation: ${path}`);
    if (path.startsWith(`/api/state?threadId=${thread.id}`)) return structuredClone(state);
    if (path === `/api/threads/${thread.id}`) return structuredClone(fixture.detail);
    throw new Error(`Synthetic read escaped presentation cache: ${path}`);
  });
  vi.doMock("../desktop/renderer/src/api.js", () => ({ request }));
  const { appState, viewState } = await import("../desktop/renderer/src/state.js");
  const controller = await import("../desktop/renderer/src/threads.js");
  const { humanTurns } = await import("../desktop/renderer/src/product-workspace/model.js");
  const expectedHumans = originalInteractions.filter(turn => !calls.some(call => call.record.activator === "agent" && String(call.resultInteractionId) === String(turn.id)));
  try {
    // Initial page startup preserves the URL reading intent through refresh.
    await controller.refreshState(thread.id);
    expect(viewState.currentInteractionId).toBe(restoredSource);
    expect(appState.visibleLayer.layer.id).toBe(`source-layer:${calls[0].record.id}`);
    const firstStateQuery = new URL(request.mock.calls[0][0], "http://localhost").searchParams;
    expect(firstStateQuery.has("currentProjectionInteractionId")).toBe(false);
    const sources = appState.interactions.filter(turn => turn.inertInvocationSource);
    expect(sources).toHaveLength(2);
    expect(sources.map(source => source.invocationId)).toEqual(calls.map(call => call.record.id));
    expect(sources.map(source => source.frozenInvocationSource)).toEqual(frozenRecords.map(record => record.source));
    expect(sources.every(source => source.completionStatus === fixture.parentStatus)).toBe(true);
    expect(humanTurns(appState, thread)).toEqual(expectedHumans);
    for (const [index, call] of calls.entries()) {
      const sourceId = `source:${call.record.id}`;
      const currentId = `current:${call.record.id}`;
      const sourceLayerId = `source-layer:${call.record.id}`;
      window.document.querySelector("#turnPickerButton").click();
      const sourceButton = window.document.querySelector(`[data-turn-id="${sourceId}"]`);
      expect(sourceButton).toBeTruthy();
      expect(sourceButton.disabled).toBe(false);
      sourceButton.click();
      await vi.waitFor(() => expect(viewState.currentInteractionId).toBe(sourceId));
      expect(appState.visibleLayer.layer.id).toBe(sourceLayerId);
      expect(appState.visibleLayer.layer.state).toBe("draft");
      expect(appState.nodes[0].id).toBe(call.record.source.parentNodeId);
      expect(appState.actions[0].interactionText).toBe(call.record.source.instruction);
      expect(window.document.querySelector("#threadView").dataset.canCompose).toBe("false");
      const currentButton = window.document.querySelector(`[data-imported-invocation-id="${call.record.id}"]`);
      expect(currentButton?.disabled).toBe(false);
      expect(currentButton.textContent).toContain(call.record.source.label);
      expect(window.document.querySelectorAll("[data-imported-invocation-id]")).toHaveLength(1);
      currentButton.click();
      await vi.waitFor(() => expect(viewState.currentInteractionId).toBe(currentId));
      expect(appState.visibleLayer.layer.id).toBe(call.record.currentLayerId);
      expect(appState.nodes[0].title).toBe(index === 0 ? "First contribution" : "Second contribution");
      expect(viewState.invocationOrigin).toMatchObject({ kind: "imported", invocationId: call.record.id,
        sourceEntry: { turnId: sourceId, selectedNodeId: call.record.source.parentNodeId } });
      expect(window.document.querySelector("#threadView").dataset.canCompose).toBe("false");
      const breadcrumb = window.document.querySelector("button.breadcrumb-invoke-origin");
      expect(breadcrumb?.textContent).toContain(call.record.source.parentTitle);
      await controller.refreshState(thread.id);
      expect(viewState.currentInteractionId).toBe(currentId);
      expect(viewState.invocationOrigin.sourceEntry.turnId).toBe(sourceId);
      window.document.querySelector("button.breadcrumb-invoke-origin").click();
      await vi.waitFor(() => expect(viewState.currentInteractionId).toBe(sourceId));
      expect(viewState.selectedNodeId).toBe(call.record.source.parentNodeId);
      expect(appState.visibleLayer.layer.id).toBe(sourceLayerId);
      expect(appState.actions[0].interactionText).toBe(call.record.source.instruction);
      window.document.querySelector("#historyBack").click();
      await vi.waitFor(() => expect(viewState.currentInteractionId).toBe(currentId));
      window.document.querySelector("#historyForward").click();
      await vi.waitFor(() => expect(viewState.currentInteractionId).toBe(sourceId));
      expect(appState.visibleLayer.layer.id).toBe(sourceLayerId);
      expect(await controller.invokeAction(appState.actions[0])).toBeNull();
      expect(await controller.navigateImportedInvocationHistory({ record: { id: calls[1 - index].record.id } })).toBe(false);
    }
    expect(appState.actionInvocations).toEqual([]);
    expect(appState.interactions.filter(turn => !turn.inertInvocationSource && !turn.inertInvocationCurrent)).toEqual(originalInteractions);
    expect(humanTurns(appState, thread)).toEqual(expectedHumans);
    expect(calls.map(call => call.record)).toEqual(frozenRecords);
    expect(calls.every(call => call.sourceNodeId == null && call.sourceActionId == null && call.presentingLayerId == null)).toBe(true);
    // A changed server-retained record invalidates the old Current and origin.
    const secondCall = calls[1];
    window.document.querySelector(`[data-imported-invocation-id="${secondCall.record.id}"]`).click();
    await vi.waitFor(() => expect(viewState.currentInteractionId).toBe(`current:${secondCall.record.id}`));
    secondCall.record.source.instruction = "Changed retained evidence";
    await controller.refreshState(thread.id);
    expect(viewState.currentInteractionId).toBe(`source:${secondCall.record.id}`);
    expect(viewState.invocationOrigin).toBeNull();
    expect(appState.actions[0].interactionText).toBe("Changed retained evidence");
    expect(appState.interactions.some(turn => turn.id === `current:${secondCall.record.id}`)).toBe(false);
    state.importedInvocationHistory = [];
    await controller.refreshState(thread.id);
    expect(appState.interactions.filter(turn => turn.inertInvocationSource || turn.inertInvocationCurrent)).toEqual([]);
    expect(appState.interactions).toEqual(originalInteractions);
    expect(await controller.navigateImportedInvocationHistory(secondCall)).toBe(false);
    await expect(controller.navigateHistory("back")).rejects.toThrow(/unavailable/);
    expect(request.mock.calls.every(([path, options]) => (!options?.method || options.method === "GET")
      && !path.includes("source%3A") && !path.includes("current%3A") && !path.includes("source-layer") && !path.includes("/layers/") && !path.includes("/invoke"))).toBe(true);
  } finally { controller.cancelNavigationHistory(); await window.happyDOM.close(); }
});
