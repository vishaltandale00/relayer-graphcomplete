import { Window } from "happy-dom";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { humanTaskInvocationResults, observeHumanTaskPresentation } from "../desktop/renderer/src/human-task-observer.js";
import { taskActorPresentationReady } from "../desktop/eval-main/task-actor-browser.mjs";
import { createProductWorkspace } from "../desktop/renderer/src/product-workspace/workspace.js";

afterEach(() => vi.unstubAllGlobals());

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

it.each([["accepted", "accepted"], ["failed", "model_failed"], ["stopped", "stopped"], ["not_started", "model_failed"]])("withholds %s/%s invocation readiness while the actual source detail render is pending", async (completionStatus, outcome) => {
  const window = new Window(), document = window.document;
  vi.stubGlobal("window", window); vi.stubGlobal("document", document);
  vi.stubGlobal("lucide", new Proxy({ createElement: () => document.createElement("svg") }, { get: (target, key) => target[key] ?? {} }));
  document.body.innerHTML = '<section id="threadView"></section><div id="toast"></div>';
  const action = { id: 22, clientKey: "improve", sourceNodeId: 36, kind: "invoke", label: "Improve", interactionText: "Improve", reusable: false };
  const node = { id: 36, clientKey: "results", kind: "concept", title: "Results", detail: "The current source." };
  const layer = { layer: { id: 10 }, nodes: [node], edges: [], actions: [action] };
  const source = { id: 7, threadId: 1, graphNodeId: 70, sequence: 1, completionStatus: "accepted", completionOutput: { rootLayer: layer } };
  const child = { id: 8, latestAttempt: { id: 82, outcome: null }, completionStatus: "running", privateGraph: "UNSEEN_CHILD_CONTENT" };
  const call = { durable: true, invocationKey: "exact-call", sourceInteractionId: 7, actionId: 22, resultInteractionId: 8, resultCompletionStatus: "running" };
  const state = { currentInteractionId: 7, interactions: [source, child], visibleLayer: layer, nodes: [node], actions: [action], actionInvocations: [call], pendingActionInvocations: [], invocationInventoryAvailable: true,
    projects: [], permissionProfiles: [], modelSettings: { defaults: {}, harnesses: [], providers: [], families: [] }, modelCatalog: [] };
  const selection = { currentThreadId: 1, currentInteractionId: 7, selectedNodeId: 36, layerPath: [] };
  let release, requested, assetWasRequested = false;
  const held = new Promise(resolve => { release = resolve; });
  const assetRequested = new Promise(resolve => { requested = resolve; });
  const workspace = createProductWorkspace({ root: document, mode: "interactive", getState: () => state, getThread: () => ({ id: 1, rootInteractionId: 7, harnessId: "fixture" }), selection,
    showThread() {}, showEmpty() {}, resolveNodeDetailAsset: async asset => { assetWasRequested = true; requested(); await held; return { ...asset, url: "blob:http://127.0.0.1/fixture", release() {} }; } });
  const frames = [], local = [];
  window.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  const expected = { threadId: 1, turnId: 7, attemptId: 71, submittedAt: 0, invocation: { actionId: 22, turnId: 8, attemptId: 82, completionStatus, attemptOutcome: outcome } };
  let stop;
  try {
    workspace.render();
    await vi.waitFor(() => expect(document.querySelector(".invocation-result-control")?.textContent).toContain("running"));
    document.querySelector("#graphStage").getBoundingClientRect = () => ({ width: 100 });
    stop = observeHumanTaskPresentation({ documentObject: document, windowObject: window,
      getState: () => ({ threadId: 1, turnId: 7, attemptId: 71, completionStatus: "accepted", invocationResults: humanTaskInvocationResults(state, 7, workspace.invocationResults()) }),
      bridge: { present: snapshot => local.push(snapshot), observe: async () => {} } });
    frames.splice(0).forEach(frame => frame()); frames.splice(0).forEach(frame => frame());
    child.completionStatus = completionStatus; child.latestAttempt.outcome = outcome; call.resultCompletionStatus = completionStatus;
    const content = { version: 1, components: [{ id: "source", order: 0, html: '<button data-gc-mount="invoke">Improve</button><span data-asset-mount="asset"></span>', css: "" }],
      mounts: [{ id: "invoke", componentId: "source", kind: "capability", host: "button", capability: { kind: "invoke", action: { clientKey: "improve", sourceNode: { clientKey: "results" } } } },
        { id: "asset", componentId: "source", kind: "asset", host: "span", assetId: "figure" }], assets: [{ id: "figure", digestSha256: "a".repeat(64), mediaType: "image/svg+xml", representation: "image" }] };
    const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
    node.authoredDetail = { ...content, integritySha256: createHash("sha256").update(canonical(content)).digest("hex") };
    workspace.render();
    await vi.waitFor(() => expect(assetWasRequested, document.querySelector("#detailContent").innerHTML).toBe(true));
    await assetRequested;
    document.dispatchEvent(new window.Event("visibilitychange"));
    frames.splice(0).forEach(frame => frame()); frames.splice(0).forEach(frame => frame());
    expect(taskActorPresentationReady({ expected, presentation: local.at(-1) })).toBe(false);
    release();
    await vi.waitFor(() => expect(document.querySelector(".invocation-result-control")?.textContent).toContain(completionStatus));
    document.dispatchEvent(new window.Event("visibilitychange"));
    frames.splice(0).forEach(frame => frame()); frames.splice(0).forEach(frame => frame());
    expect(taskActorPresentationReady({ expected, presentation: local.at(-1) })).toBe(true);
    expect(workspace.invocationResults()).toEqual([expected.invocation]);
    selection.selectedNodeId = 99;
    expect(workspace.invocationResults()).toEqual([]);
    selection.selectedNodeId = 36;
    expect(JSON.stringify(local)).not.toContain("UNSEEN_CHILD_CONTENT");
  } finally { release(); stop?.(); workspace.dispose(); await window.happyDOM.close(); }
});
