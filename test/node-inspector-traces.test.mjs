import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NodeInspectorWorld,
  PROMISES,
  comparable,
} from "./support/node-inspector-trace-adapter.mjs";

// Scenario traces rendered from models/tla/NodeInspector.tla (see
// models/tla/README.md). Each step replays against the real Product
// workspace and its node context draft controller in happy-dom. The real
// inspector must equal the model's state after every step. A scenario's
// promises must hold throughout; a promise in violatedAtEnd is an open bug
// that both the model and the code break at the final step.
const traceDirectory = join(import.meta.dirname, "..", "models", "tla", "traces");
const traces = readdirSync(traceDirectory)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(join(traceDirectory, file), "utf8")))
  .filter((trace) => trace.module === "NodeInspector");

const describeStep = (action) => (action ? action.join(" ") : "initial state");
let world;

afterEach(() => {
  world?.dispose();
  world = null;
});

describe("NodeInspector traces replay against the Product workspace inspector", () => {
  it("has traces to replay", () => {
    expect(traces.length).toBeGreaterThan(0);
  });

  for (const trace of traces) {
    it(`${trace.scenario}: ${trace.summary}`, async () => {
      world = await new NodeInspectorWorld().ready();
      const last = trace.steps.length - 1;
      let before = null;
      for (const [index, { action, state }] of trace.steps.entries()) {
        if (action) await world.apply(action, before, state);
        before = state;
        const real = world.observe();
        const where = `step ${index} (${describeStep(action)})`;
        const [observed, expected] = comparable(real, state);
        expect(observed, `${where}: real state diverges from the model`).toEqual(expected);
        for (const promise of trace.promises) {
          expect(PROMISES[promise](real, state), `${where}: ${promise} is broken`).toBe(true);
        }
        for (const promise of trace.violatedAtEnd ?? []) {
          expect(PROMISES[promise](real, state), `${where}: ${promise} ${index === last ? "no longer breaks; the bug is fixed" : "breaks early"}`)
            .toBe(index !== last);
        }
      }
    });
  }
});

// Not in NodeInspector.tla, which has one thread.
describe("A request waiting for a resolving draft", () => {
  const quietModel = { slots: {} };

  it("lets Close supersede a sidebar change and restores the saved draft on reopening", async () => {
    const trace = traces.find((candidate) => candidate.scenario === "inspector-close-during-flush");
    world = await new NodeInspectorWorld().ready();
    for (let index = 1; index <= 4; index += 1) {
      await world.apply(trace.steps[index].action, trace.steps[index - 1].state, trace.steps[index].state);
    }
    const text = world.window.document.querySelector('#contextAnnotationEditor').value;
    const sidebarChange = world.workspace.prepareSelectionChange();
    await world.apply(["Close"], quietModel, quietModel);
    await world.apply(["SaveReturns", 1, "ok"], quietModel, quietModel);
    expect(await sidebarChange).toBe(false);
    expect(world.selection.currentThreadId).toBe(3);
    expect(world.observe().open).toBe(false);
    await world.apply(["Click", "n1"], quietModel, quietModel);
    const editor = world.window.document.querySelector('#contextAnnotationEditor');
    expect(editor.value).toBe(text);
    expect(editor.disabled).toBe(false);
  });

  it("is void once the user switches to another thread", async () => {
    // The trace's first steps annotate n1 and start discarding its draft.
    const trace = traces.find((candidate) => candidate.scenario === "inspector-view-change-during-discard");
    const discard = trace.steps.findIndex(({ action }) => action?.[0] === "Discard");
    world = await new NodeInspectorWorld().ready();
    for (let index = 1; index <= discard; index += 1) {
      await world.apply(trace.steps[index].action, trace.steps[index - 1].state, trace.steps[index].state);
    }
    const turnChange = world.workspace.prepareSelectionChange();
    world.thread = { ...world.thread, id: 4, title: "Other thread" };
    world.selection.currentThreadId = 4;
    world.workspace.render();
    await world.apply(["DiscardReturns", "ok"], quietModel, quietModel);
    expect(await turnChange).toBe(false);
  });

  it("is void after a round trip through another view with the same key", async () => {
    const trace = traces.find((candidate) => candidate.scenario === "inspector-view-change-during-discard");
    const discard = trace.steps.findIndex(({ action }) => action?.[0] === "Discard");
    world = await new NodeInspectorWorld().ready();
    for (let index = 1; index <= discard; index += 1) {
      await world.apply(trace.steps[index].action, trace.steps[index - 1].state, trace.steps[index].state);
    }
    world.window.document.querySelector('[data-node="8"]').click();
    const home = world.layerId;
    await world.showLayer(home + 50);
    await world.showLayer(home);
    await world.apply(["DiscardReturns", "ok"], quietModel, quietModel);
    expect(String(world.selection.selectedNodeId)).not.toBe("8");
  });

  it("shows the kept node again when a switch's destination disappears", async () => {
    const trace = traces.find((candidate) => candidate.scenario === "inspector-click-during-switch");
    const switching = trace.steps.findIndex(({ action }, index) => index > 1 && action?.[0] === "Click");
    world = await new NodeInspectorWorld().ready();
    for (let index = 1; index <= switching; index += 1) {
      await world.apply(trace.steps[index].action, trace.steps[index - 1].state, trace.steps[index].state);
    }
    await world.showLayer(world.layerId, ["n1"]);
    await world.apply(["SaveReturns", 1, "ok"], quietModel, quietModel);
    const real = world.observe();
    expect(real).toMatchObject({ sel: "n1", open: true, title: { node: "n1" }, detail: { node: "n1", live: true } });
    expect(real.dock.node).toBe("n1");
    // The kept node shows the refresh that arrived during the save.
    expect(real.title.rev).toBe(real.srev);
  });

  it("waits for a discard the user left and returned to", async () => {
    const trace = traces.find((candidate) => candidate.scenario === "inspector-view-change-during-discard");
    const discard = trace.steps.findIndex(({ action }) => action?.[0] === "Discard");
    world = await new NodeInspectorWorld().ready();
    for (let index = 1; index <= discard; index += 1) {
      await world.apply(trace.steps[index].action, trace.steps[index - 1].state, trace.steps[index].state);
    }
    const home = world.thread;
    world.thread = { ...home, id: 4, title: "Other thread" };
    world.selection.currentThreadId = 4;
    world.workspace.render();
    world.thread = home;
    world.selection.currentThreadId = home.id;
    world.workspace.render();
    await world.settled();
    world.window.document.querySelector('[data-node="8"]').click();
    await world.settled();
    expect(String(world.selection.selectedNodeId)).toBe("7");
    await world.apply(["DiscardReturns", "ok"], quietModel, quietModel);
    expect(String(world.selection.selectedNodeId)).toBe("8");
  });

  it("keeps waiting while a remounted discard reconciles a revision conflict", async () => {
    const trace = traces.find((candidate) => candidate.scenario === "inspector-view-change-during-discard");
    const discard = trace.steps.findIndex(({ action }) => action?.[0] === "Discard");
    world = await new NodeInspectorWorld().ready();
    for (let index = 1; index <= discard; index += 1) {
      await world.apply(trace.steps[index].action, trace.steps[index - 1].state, trace.steps[index].state);
    }
    const home = world.thread;
    world.thread = { ...home, id: 4, title: "Other thread" };
    world.selection.currentThreadId = 4;
    world.workspace.render();
    world.thread = home;
    world.selection.currentThreadId = home.id;
    world.workspace.render();
    await world.settled();
    // The server holds a newer revision: the first discard conflicts, the
    // controller reloads it, and discards again.
    world.listedDrafts = [{
      ...world.lastSavedDraft, revision: world.draftRevision + 1,
      createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:01Z",
    }];
    world.discards.shift().response.reject(Object.assign(new Error("changed"), {
      status: 409, code: "context_draft_revision_conflict",
    }));
    await world.settled();
    world.window.document.querySelector('[data-node="8"]').click();
    await world.settled();
    expect(String(world.selection.selectedNodeId)).toBe("7");
    await world.apply(["DiscardReturns", "ok"], quietModel, quietModel);
    expect(String(world.selection.selectedNodeId)).toBe("8");
  });

  it("is void once the user leaves every thread for New Thread", async () => {
    const trace = traces.find((candidate) => candidate.scenario === "inspector-view-change-during-discard");
    const discard = trace.steps.findIndex(({ action }) => action?.[0] === "Discard");
    world = await new NodeInspectorWorld().ready();
    for (let index = 1; index <= discard; index += 1) {
      await world.apply(trace.steps[index].action, trace.steps[index - 1].state, trace.steps[index].state);
    }
    const back = world.workspace.prepareSelectionChange();
    world.thread = null;
    world.selection.currentThreadId = null;
    world.workspace.render();
    await world.apply(["DiscardReturns", "ok"], quietModel, quietModel);
    expect(await back).toBe(false);
  });
});

// Plain Enter follows the same durable confirmation seam as the checkmark.
describe("annotation keyboard confirmation", () => {
  it.each([false, true])("confirms with Enter and preserves Send admission while running=%s", async (running) => {
    const send = vi.fn(async () => {});
    world = await new NodeInspectorWorld({ onSubmitInteraction: send }).ready();
    world.state.conversationCompatibility = { threadId: 3, status: "unrestricted", harnessId: "fixture" };
    world.workspace.render();
    const quiet = { slots: {} };
    const trace = traces.find((candidate) => candidate.scenario === "inspector-close-during-flush");
    const annotated = trace.steps.findIndex(({ action }) => action?.[0] === "Annotate");
    for (let index = 1; index <= annotated; index += 1) {
      await world.apply(trace.steps[index].action, trace.steps[index - 1].state, trace.steps[index].state);
    }
    await world.apply(["EditDraft"], quiet, quiet);
    await world.apply(["Autosave"], quiet, quiet);
    if (running) {
      world.state.interactions.push({ id: 6, threadId: 3, sequence: 2, text: "Continue", completionStatus: "running" });
      world.workspace.render();
    }
    const editor = world.window.document.querySelector("#contextAnnotationEditor");
    editor.focus();
    for (const options of [{ shiftKey: true }, { isComposing: true }, { repeat: true }]) {
      editor.dispatchEvent(new world.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...options }));
      expect(world.confirms).toHaveLength(0);
    }
    const event = new world.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    editor.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    // Chromium blurs when the pending confirmation disables the editor.
    world.window.document.body.tabIndex = -1;
    world.window.document.body.focus();
    expect(world.window.document.activeElement).toBe(world.window.document.body);
    await world.apply(["ConfirmReturns", "ok"], quiet, quiet);
    expect(world.window.document.querySelector("#nodeContextDock").classList.contains("hidden")).toBe(true);
    const prompt = world.window.document.querySelector("#threadPrompt");
    expect(prompt.disabled).toBe(running);
    if (!running) expect(world.window.document.activeElement).toBe(prompt);
    expect(send).not.toHaveBeenCalled();
    if (running) {
      prompt.dispatchEvent(new world.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve));
      expect(send).not.toHaveBeenCalled();
      world.state.interactions.at(-1).completionStatus = "accepted";
      world.workspace.render();
      expect(prompt.disabled).toBe(false);
      expect(send).not.toHaveBeenCalled();
      prompt.focus();
    }
    prompt.dispatchEvent(new world.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][2][0].annotations).toEqual(["x"]);
  });
});
