import { Window } from "happy-dom";
import { expect, it } from "vitest";
import { observeHumanTaskPresentation } from "../desktop/renderer/src/human-task-observer.js";

it("publishes local after-paint Current while evidence persistence is queued", async () => {
  const window = new Window();
  const document = window.document;
  const layout = document.createElement("div"); layout.className = "workspace-layout";
  const graph = document.createElement("div"); graph.id = "graphStage";
  graph.getBoundingClientRect = () => ({ width: 100 });
  layout.append(graph); document.body.append(layout);
  const frames = [];
  window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  let revision = 1;
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const local = []; const durable = [];
  const stop = observeHumanTaskPresentation({ documentObject: document, windowObject: window,
    getState: () => ({ currentPointer: { revision, mode: "following", layerId: revision } }),
    bridge: { present: snapshot => local.push(snapshot.currentPointer.revision), observe: async snapshot => { durable.push(snapshot.currentPointer.revision); await held; } },
  });
  try {
    frames.shift()(); frames.shift()();
    await Promise.resolve(); await Promise.resolve();
    expect(durable).toEqual([1]);
    revision = 2;
    document.dispatchEvent(new window.Event("visibilitychange"));
    frames.shift()(); frames.shift()();
    expect(local).toEqual([1, 2]);
    expect(durable).toEqual([1]);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(durable).toEqual([1, 2]);
  } finally { release(); stop(); await window.happyDOM.close(); }
});
