import { readFileSync } from "node:fs";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";

const actualFixture = JSON.parse(readFileSync(new URL("./fixtures/inert-returned-call.json", import.meta.url), "utf8"));
afterEach(() => vi.unstubAllGlobals());

describe("submitted input history in the turn banner", () => {
  it("keeps collapsed rows bounded, opens the exact value, and survives refreshes", async () => {
    const { detail, sourceLayer } = structuredClone(actualFixture);
    const window = new Window({ url: "http://127.0.0.1:3000" });
    vi.stubGlobal("document", window.document); vi.stubGlobal("window", window);
    vi.stubGlobal("lucide", new Proxy({ Circle: {}, createElement: () => window.document.createElement("svg") }, { get: (target, key) => target[key] ?? {} }));
    window.document.body.innerHTML = '<section id="threadView"></section><div id="toast"></div>';
    const source = detail.interactions.find(item => item.id === detail.importedInvocationHistory[0].sourceInteractionId);
    const exact = `First line\n${"long rationale ".repeat(4 * 1024)}`;
    source.submittedInputs = [
      { action: { control: "text", prompt: "Deployment rationale" }, value: { text: exact } },
      ...Array.from({ length: 8 }, (_, index) => ({ action: { control: "single_select", prompt: `Question ${index + 2}` }, value: { selected: [{ key: `k${index}`, label: `Answer ${index + 2}` }] } })),
    ];
    const state = { ...detail, status: "accepted", currentInteractionId: source.id, visibleLayer: sourceLayer, nodes: sourceLayer.nodes, actions: sourceLayer.actions, projects: [], permissionProfiles: [], modelSettings: { defaults: { harnessId: "fixture" }, harnesses: [{ id: "fixture", available: true }], providers: [], families: [] }, modelCatalog: [], pendingActionInvocations: [] };
    const selection = { currentThreadId: detail.thread.id, currentInteractionId: source.id, selectedNodeId: null, layerPath: [] };
    const workspace = createProductWorkspace({ root: window.document, mode: "review", getState: () => state, getThread: () => detail.thread, selection, showThread() {}, showEmpty() {} });
    try {
      workspace.render();
      const host = window.document.querySelector("#interactionInputHistory");
      await vi.waitFor(() => expect(host.querySelectorAll(".interaction-input-history-item")).toHaveLength(9));
      expect(host.querySelector("strong").textContent).toBe("Submitted inputs · 9");
      const row = host.querySelector(".interaction-input-history-item");
      const [prompt, value] = row.querySelector("summary").children;
      expect(prompt.textContent).toBe("Deployment rationale");
      expect([...value.textContent]).toHaveLength(80);
      expect(value.textContent.endsWith("…")).toBe(true);

      row.open = true;
      await vi.waitFor(() => expect(value.textContent).toBe(exact));
      const list = host.querySelector(".interaction-input-history-list");
      list.scrollTop = 40;
      workspace.render();
      expect(host.querySelector(".interaction-input-history-item")).toBe(row);
      expect(row.open).toBe(true);
      expect(list.scrollTop).toBe(40);

      row.open = false;
      await vi.waitFor(() => expect([...value.textContent]).toHaveLength(80));

      source.submittedInputs = source.submittedInputs.slice(1);
      workspace.render();
      expect(host.querySelector("strong").textContent).toBe("Submitted inputs · 8");
    } finally { workspace.dispose(); await window.happyDOM.close(); }
  });
});
