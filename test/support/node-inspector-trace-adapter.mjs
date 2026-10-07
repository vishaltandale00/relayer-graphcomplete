// Replays NodeInspector.tla scenario traces against the real Product
// workspace (createProductWorkspace) rendered in happy-dom, with its real
// node context draft controller.
//
// Each spec action becomes the user event or continuation it abstracts:
// Click clicks a graph node, Annotate clicks #attachNodeContext, EditDraft
// types in the annotation editor, Discard clicks ×, Close clicks
// #closeInspector, and StatePush replaces the state's node objects with
// new ones for the same nodes, as a refresh of the same accepted layer does,
// and calls render(). Each node's kind names the state revision it came
// from, so the header shows which state the inspector rendered. The awaits the spec splits at are held
// on deferreds: every draft save and discard request, and every Node Detail
// asset, so a step resumes exactly one of them. Autosave fires the
// controller's 350 ms save timer and lets that save land.
//
// A spec slot is an in-flight selectNode. After each step the adapter pairs
// every slot the model newly started mounting a fresh runtime into with the
// next asset request for that node, so MountReturns(k) resolves that mount.
// A slot that reuses the mounted runtime completes without an asset.
//
// observe() reads the inspector back as the spec's observable variables:
// the selection, whether the inspector is open, the node and state revision
// the header shows, the Node Detail
// host and whether its page is shown, and the annotation dock. The editor's
// identity, the slots, and the controller's draft set are internal state,
// so the replay compares what they produce.

import { createHash } from "node:crypto";
import { Window } from "happy-dom";
import { vi } from "vitest";

import { createProductWorkspace } from "../../desktop/renderer/src/product-workspace/workspace.js";

const NODE_ID = Object.freeze({ n1: 7, n2: 8 });
const specNode = (id) => Object.keys(NODE_ID).find((key) => NODE_ID[key] === Number(id)) ?? "none";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let turn = 0; turn < 40; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Waits until no digest is in flight and a probe's value has held for 30 ms
// of real time. A Node Detail mount verifies its package with crypto.subtle,
// which answers off the event loop, so a fixed number of turns can end
// before it renders on a slow machine. Only setTimeout is faked, so
// setImmediate and Date.now are real.
async function quiesce(probe, busy) {
  const deadline = Date.now() + 5000;
  let last = probe();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
    const now = probe();
    if (now !== last || busy()) {
      last = now;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 30) {
      return;
    }
  }
  throw new Error("The inspector did not settle");
}

async function until(condition, what) {
  for (let turn = 0; turn < 2000; turn += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function compiledPackage(content) {
  return { ...content, integritySha256: createHash("sha256").update(canonicalJson(content)).digest("hex") };
}

// An authored page with one asset, so each fresh mount waits on that asset.
const AUTHORED_DETAIL = compiledPackage({
  version: 1,
  components: [{
    id: "page",
    order: 0,
    html: '<section><p>Authored detail</p><span aria-hidden="true" data-asset-mount="visual"></span></section>',
    css: "p{margin:0}",
  }],
  mounts: [{ id: "visual", componentId: "page", kind: "asset", host: "span", assetId: "visual" }],
  assets: [{ id: "visual", digestSha256: "a".repeat(64), mediaType: "image/svg+xml", representation: "image" }],
});

export class NodeInspectorWorld {
  constructor({ onSubmitInteraction = async () => {} } = {}) {
    this.window = new Window({ url: "http://127.0.0.1:3000" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    this.pendingDigests = 0;
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    this.digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
      this.pendingDigests += 1;
      try {
        return await digest(...args);
      } finally {
        this.pendingDigests -= 1;
      }
    });
    vi.stubGlobal("document", this.window.document);
    vi.stubGlobal("window", this.window);
    vi.stubGlobal("localStorage", this.window.localStorage);
    vi.stubGlobal("lucide", new Proxy({
      createElement: () => this.window.document.createElement("svg"),
    }, { get: (target, key) => target[key] ?? {} }));
    this.window.document.body.innerHTML = '<section id="threadView"></section><div id="toast" class="hidden"></div>';
    this.srev = 1;
    this.layerId = 99;
    this.visible = Object.keys(NODE_ID);
    this.saves = [];
    this.discards = [];
    this.confirms = [];
    this.assets = [];
    this.slotAssets = new Map();
    this.draftRevision = 0;
    this.thread = { id: 3, title: "Thread", harnessId: "fixture", projectId: null, permissionProfileId: null };
    // The user has closed Node Details, as the spec's initial state says, so
    // the first view selects nothing.
    this.selection = {
      currentThreadId: 3, currentInteractionId: 5, selectedNodeId: null, layerPath: [], nodeDetailsClosed: true,
    };
    this.state = {
      status: "accepted",
      currentInteractionId: 5,
      interactions: [],
      edges: [],
      actions: [],
      projects: [],
      permissionProfiles: [],
      modelSettings: {
        defaults: { harnessId: "fixture" },
        harnesses: [{ id: "fixture", label: "Fixture", available: true }],
        providers: [],
        families: [],
      },
      modelCatalog: [],
      actionInvocations: [],
      pendingActionInvocations: [],
    };
    this.#loadState();
    const world = this;
    // The nodes the workspace reported as selected during the last step.
    this.reported = [];
    this.workspace = createProductWorkspace({
      root: this.window.document,
      getState: () => this.state,
      getThread: () => this.thread,
      selection: this.selection,
      // As the desktop host does (threads.js replaceCurrentSelection), a
      // reported null means the user closed Node Details.
      onSelectionChange: (id) => {
        world.selection.nodeDetailsClosed = id == null;
        if (id != null) world.reported.push(specNode(id));
      },
      showThread: () => {},
      showEmpty: () => {},
      onSubmitInteraction,
      resolveNodeDetailAsset: (_asset, { node }) => {
        const request = { node: specNode(node.id), response: deferred(), slot: null };
        world.assets.push(request);
        return request.response.promise;
      },
      contextDraftApi: {
        list: async () => ({ drafts: world.listedDrafts ?? [], confirmations: [] }),
        save: (_threadId, draft) => {
          world.lastSavedDraft = draft;
          const request = { node: specNode(draft.target.nodeId), response: deferred() };
          world.saves.push(request);
          return request.response.promise;
        },
        discard: () => {
          const request = { response: deferred() };
          world.discards.push(request);
          return request.response.promise;
        },
        // Confirm resolves like discard in the spec: the draft leaves the
        // draft set and its editor closes.
        confirm: (_threadId, draft) => {
          const request = { draft, response: deferred() };
          world.confirms.push(request);
          return request.response.promise;
        },
      },
    });
    this.workspace.render();
  }

  async ready() {
    await settle();
    return this;
  }

  // A refresh brings new node objects for the same nodes, whose kind names
  // the state revision; a new view brings another layer with the given nodes.
  #loadState() {
    const nodes = Object.entries(NODE_ID).filter(([key]) => this.visible.includes(key)).map(([key, id]) => ({
      id,
      kind: `revision-${this.srev}`,
      icon: "box",
      title: `Node ${key}`,
      detail: `Legacy ${key}`,
      authoredDetail: AUTHORED_DETAIL,
    }));
    const layer = {
      layer: {
        id: this.layerId,
        layout: { version: 1, placements: nodes.map((node, index) => ({ nodeId: node.id, x: 0.3 + index * 0.4, y: 0.5 })) },
      },
      nodes,
      edges: [],
      actions: [],
    };
    // A refresh delivers a new state object, so code holding an older state
    // keeps seeing the older content. The desktop host mutates one appState
    // in place instead; this is stricter, and catches stale-state code.
    this.state = {
      ...this.state,
      interactions: [{
        id: 5, threadId: 3, sequence: 1, text: "Question", graphNodeId: 50,
        completionStatus: "accepted", completionOutput: { rootLayer: layer },
      }],
      visibleLayer: layer,
      nodes: [...nodes],
    };
  }

  #respond(queue, what, ok, value) {
    const request = queue.shift();
    if (!request) throw new Error(`${what}: nothing is pending`);
    if (ok) request.response.resolve(value);
    else request.response.reject(Object.assign(new Error(`${what} failed`), { status: 503 }));
  }

  #savedDraft() {
    this.draftRevision += 1;
    return { revision: this.draftRevision, createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z" };
  }

  async apply([name, ...args], before, after) {
    const $ = (selector) => this.window.document.querySelector(selector);
    this.reported = [];
    switch (name) {
      case "Click": {
        const element = $(`[data-node="${NODE_ID[args[0]]}"]`);
        if (!element) throw new Error(`Click: node ${args[0]} is not on the canvas`);
        element.click();
        break;
      }
      case "Annotate": {
        const button = $("#attachNodeContext");
        if (button.disabled || button.classList.contains("hidden")) throw new Error("Annotate: + is unavailable");
        button.click();
        break;
      }
      case "EditDraft": {
        const textarea = $("#nodeContextDock #contextAnnotationEditor");
        if (!textarea || textarea.disabled) throw new Error("EditDraft: no editable annotation editor");
        textarea.value = `${textarea.value}x`;
        textarea.dispatchEvent(new this.window.Event("input", { bubbles: true }));
        break;
      }
      case "Discard": {
        const button = $('#nodeContextDock [aria-label^="Discard annotation draft"]');
        if (!button || button.disabled) throw new Error("Discard: × is unavailable");
        button.click();
        break;
      }
      case "Close": {
        $("#closeInspector").click();
        break;
      }
      case "Autosave": {
        vi.advanceTimersByTime(350);
        await until(() => this.saves.length > 0, "the autosave request");
        this.#respond(this.saves, "Autosave", true, this.#savedDraft());
        break;
      }
      case "SaveReturns":
      case "PrepareReturns": {
        const ok = (name === "SaveReturns" ? args[1] : args[0]) === "ok";
        await until(() => this.saves.length > 0, "the draft save request");
        this.#respond(this.saves, name, ok, this.#savedDraft());
        break;
      }
      case "Confirm": {
        const button = $('#nodeContextDock [aria-label="Confirm annotation"]');
        if (!button || button.disabled) throw new Error("Confirm: ✓ is unavailable");
        button.click();
        break;
      }
      case "ConfirmReturns": {
        await until(() => this.confirms.length > 0, "the confirm request");
        const request = this.confirms.shift();
        if (args[0] === "ok") {
          request.response.resolve({
            draftId: request.draft.id,
            target: request.draft.target,
            targetNode: request.draft.targetNode,
            annotation: request.draft.text,
          });
        } else {
          request.response.reject(Object.assign(new Error("Confirm failed"), { status: 503 }));
        }
        break;
      }
      case "DiscardReturns": {
        await until(() => this.discards.length > 0, "the discard request");
        this.#respond(this.discards, name, args[0] === "ok", undefined);
        break;
      }
      case "MountReturns": {
        const request = this.slotAssets.get(String(args[0]));
        this.slotAssets.delete(String(args[0]));
        request?.response.resolve({
          digestSha256: "a".repeat(64),
          mediaType: "image/svg+xml",
          url: `blob:http://127.0.0.1:3000/visual-${request.node}`,
          release: () => {},
        });
        break;
      }
      case "StatePush": {
        if (args[0] !== "same") {
          this.layerId = 100 + this.srev;
          this.visible = args.slice(1);
        }
        this.srev += 1;
        this.#loadState();
        this.workspace.render();
        break;
      }
      default:
        throw new Error(`Unknown NodeInspector action ${name}`);
    }
    await settle();
    await quiesce(() => JSON.stringify(this.observe()), () => this.pendingDigests > 0);
    await this.#pairSlots(before, after);
  }

  // Pairs each slot the model newly started a fresh mount in with the next
  // unpaired asset request for that node.
  async #pairSlots(before, after) {
    for (const [slot, record] of Object.entries(after.slots)) {
      const prior = before?.slots?.[slot];
      const started = record.st === "mounting" && record.fresh
        && !(prior?.st === "mounting" && prior.node === record.node && prior.fresh);
      if (!started) continue;
      await until(() => this.assets.some((request) => request.slot === null && request.node === record.node),
        `the Node Detail asset for ${record.node} in slot ${slot}`);
      const request = this.assets.find((candidate) => candidate.slot === null && candidate.node === record.node);
      request.slot = slot;
      this.slotAssets.set(slot, request);
    }
  }

  async settled() {
    await settle();
  }

  // Not in the model: render a refresh that shows the given layer (a view
  // change when its id differs) with the given nodes.
  async showLayer(layerId, visible = this.visible) {
    this.layerId = layerId;
    this.visible = visible;
    this.srev += 1;
    this.#loadState();
    this.workspace.render();
    await settle();
  }

  // The refinement mapping onto the spec's observable variables.
  observe() {
    const $ = (selector) => this.window.document.querySelector(selector);
    const sel = this.selection.selectedNodeId == null ? "none" : specNode(this.selection.selectedNodeId);
    const heading = /^Node (n\d)$/.exec($("#detailTitle").textContent);
    const host = $("#detailContent [data-node-detail-runtime]");
    const hostNode = /^Node (n\d) authored detail$/.exec(host?.getAttribute("aria-label") ?? "")?.[1];
    const dock = $("#nodeContextDock");
    const textarea = dock.querySelector("#contextAnnotationEditor");
    const dockOpen = !dock.classList.contains("hidden") && Boolean(textarea);
    const dockNode = /^Annotation for Node (n\d)$/.exec(textarea?.getAttribute("aria-label") ?? "")?.[1];
    return {
      sel,
      open: !$("#inspector").classList.contains("hidden"),
      title: {
        node: heading?.[1] ?? "none",
        rev: Number(/^revision-(\d+)$/.exec($("#detailKind").textContent)?.[1] ?? 0),
      },
      detail: {
        node: hostNode ?? "none",
        live: Boolean(host?.isConnected && host.shadowRoot?.childNodes.length),
      },
      dock: dockOpen ? { node: dockNode ?? "none", resolving: textarea.disabled } : { node: "none", resolving: false },
      srev: this.srev,
      reported: [...this.reported],
    };
  }

  dispose() {
    this.workspace.dispose();
    this.digestSpy.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

const values = (set) => Object.values(set ?? {});

const quiet = (model) => values(model.slots).every((slot) => slot.st === "free")
  && model.prep.st === "free" && model.op.eid === 0;

// A draft is <<node, view>>; it is usable only in the view it was made in.
const hasDraftHere = (model, node) => values(model.drafts)
  .some((draft) => draft["1"] === node && draft["2"] === model.vid);

// The same projection of a trace state. The dock shows the editor only for
// the selected node's draft (renderNodeContextDock, WS:2587-2626). It is
// re-rendered at the end of selectNode, not when the switch commits, so it
// is compared only once the renderer is quiet.
export function comparable(observed, state) {
  const { reported: _reported, ...real } = observed;
  const model = projectModelState(state);
  if (quiet(state)) return [real, model];
  const { dock: _realDock, ...realRest } = real;
  const { dock: _modelDock, ...modelRest } = model;
  return [realRest, modelRest];
}

export function projectModelState(state) {
  const { editor, sel } = state;
  const docked = editor.node !== "none" && editor.node === sel && editor.vid === state.vid
    && hasDraftHere(state, sel);
  return {
    sel,
    open: state.open,
    title: { node: state.title.node, rev: state.title.rev },
    detail: { node: state.detail.node, live: state.detail.live },
    dock: docked ? { node: sel, resolving: editor.resolving } : { node: "none", resolving: false },
    srev: state.srev,
  };
}

// Promises over the real observation and the trace's ghost (what the user
// last asked for) and draft set, checked once the renderer is quiet.
export const PROMISES = {
  InspectorShowsSelection: (real, model) => !quiet(model) || (
    real.open === (real.sel !== "none")
    && (!real.open || (real.title.node === real.sel && real.detail.node === real.sel && real.detail.live))
  ),
  // While a draft resolves, an editor the dock shows is locked, so an edit
  // cannot race the save, confirm, or discard. Checked at every step.
  ResolvingEditorLocked: (real, model) => !model.editor.resolving || real.dock.node === "none"
    || real.dock.resolving,
  // Only the newest request reports a selection: every node the workspace
  // reported during the step is the one the user wants.
  OnlyLatestRequestSelects: (real, model) => real.reported.every((node) => node === model.want),
  // The header shows the latest state the workspace rendered.
  InspectorIsCurrent: (real, model) => !quiet(model) || !real.open || real.title.rev === real.srev,
  LastRequestWins: (real, model) => !quiet(model) || real.sel === model.want,
  DraftedSelectionHasEditor: (real, model) => !quiet(model) || real.sel === "none"
    || !hasDraftHere(model, real.sel) || real.dock.node === real.sel,
};
