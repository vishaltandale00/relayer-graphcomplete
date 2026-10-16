// Replays TurnComposer.tla scenario traces against the real Product workspace
// (createProductWorkspace) rendered in happy-dom.
//
// Each spec action becomes the user event or continuation it abstracts:
// Type is an input event on #threadPrompt, ClickSend clicks #sendInteraction,
// SwitchThread and the product actions change the renderer state and call
// render() as renderThread() does. The follow-up request is a fake of
// threads.submitInteraction. PostInserted records the turn on the fake
// server, as the real one does before it answers, so switching to the
// thread loads it (loadThread awaits refreshState). The fake holds three
// deferreds: the POST response, the refresh
// that renders the new turn (TH:803-808), and the await production performs
// between that refresh and settlement (the input-draft reload in
// submitInteraction, WS:3219-3227). Each spec step resumes exactly one of
// them.
//
// observe() reads the real composer back as the spec's observable variables:
// the prompt's value and disabled state, the drafts persisted in
// composer-drafts, the product state, and each thread's send phase. The
// draft-scope map and prompt revision are closure state, so the replay
// compares what they produce, not their values.

import { Window } from "happy-dom";
import { vi } from "vitest";

import { threadFollowupDraft } from "../../desktop/renderer/src/composer-drafts.js";
import { createProductWorkspace } from "../../desktop/renderer/src/product-workspace/workspace.js";

const THREAD_ID = Object.freeze({ A: 1, B: 2 });
const specThread = (threadId) => Object.keys(THREAD_ID).find((key) => THREAD_ID[key] === Number(threadId));
const interactionId = (thread, turn) => THREAD_ID[thread] * 100 + turn;
const textFor = (identity) => (identity === 0 ? "" : `draft ${identity}`);
const identityOf = (value) => (value === "" ? 0 : Number(/^draft (\d+)$/.exec(value)?.[1] ?? Number.NaN));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Runs every continuation that can run before the next user event.
async function settle() {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

export class TurnComposerWorld {
  // turnsA: thread A's turns ({ status, text }) as a restart finds them;
  // persisted: follow-up drafts an earlier session left, keyed by A's turn.
  // storage: an earlier world's storageSnapshot(), in place of persisted.
  constructor({ maxText, maxTurns, turnsA, persisted = {}, storage = null }) {
    this.maxText = maxText;
    this.maxTurns = maxTurns;
    this.window = new Window({ url: "http://127.0.0.1:3000" });
    vi.stubGlobal("document", this.window.document);
    vi.stubGlobal("window", this.window);
    vi.stubGlobal("localStorage", this.window.localStorage);
    vi.stubGlobal("lucide", new Proxy({
      createElement: () => this.window.document.createElement("svg"),
    }, { get: (target, key) => target[key] ?? {} }));
    this.window.localStorage.clear();
    this.window.localStorage.setItem("relayerComposerDraftsV1", storage ?? JSON.stringify({
      threadFollowups: Object.fromEntries(Object.entries(persisted)
        .filter(([, text]) => text != null)
        .map(([turn, text]) => [`${THREAD_ID.A}:${interactionId("A", Number(turn))}`, text])),
    }));
    this.window.document.body.innerHTML = '<section id="threadView"></section><div id="toast" class="hidden"></div>';
    this.threads = Object.fromEntries(Object.entries(THREAD_ID).map(([key, id]) => [key, {
      id, title: `Thread ${key}`, harnessId: "fixture", projectId: null, permissionProfileId: null,
    }]));
    this.turns = { A: turnsA ?? [{ status: "accepted" }], B: [{ status: "accepted" }] };
    this.pendingTurn = { A: false, B: false };
    this.recordedText = { A: undefined, B: undefined };
    this.view = "A";
    this.calls = { A: null, B: null };
    this.fresh = 0;
    this.state = {
      status: "accepted",
      currentInteractionId: null,
      interactions: [],
      nodes: [],
      edges: [],
      actions: [],
      visibleLayer: null,
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
    this.selection = { currentThreadId: null, currentInteractionId: null, selectedNodeId: null, layerPath: [] };
    this.#syncState();
    this.workspace = createProductWorkspace({
      root: this.window.document,
      getState: () => this.state,
      getThread: () => this.threads[this.view],
      selection: this.selection,
      showThread: () => {},
      showEmpty: () => {},
      onSubmitInteraction: (text) => this.#submit(text),
      // Interactive mode always has a context-draft controller; this thread
      // has no annotation drafts or confirmations.
      contextDraftApi: { list: async () => ({ drafts: [], confirmations: [] }) },
    });
    this.workspace.render();
  }

  async ready() {
    await settle();
    return this;
  }

  // Not in the model: a turn with the given text, created elsewhere or by a
  // send this renderer did not see finish, arrives in thread A.
  async turnArrivesWithText(text) {
    this.turns.A.push({ status: "accepted", text });
    if (this.view === "A") this.#render();
    else this.#syncState();
    await settle();
  }

  // The persisted record of thread A's send whose turn has not loaded.
  sentRecord() {
    const state = JSON.parse(this.window.localStorage.getItem("relayerComposerDraftsV1") || "{}");
    return state.sentThreadFollowups?.[String(THREAD_ID.A)] ?? null;
  }

  // Everything the composer persisted, for a restarted world.
  storageSnapshot() {
    return this.window.localStorage.getItem("relayerComposerDraftsV1");
  }

  // Not in the model: the draft an earlier session persisted for A's turn.
  persistedDraft(turn) {
    const state = JSON.parse(this.window.localStorage.getItem("relayerComposerDraftsV1") || "{}");
    return state.threadFollowups?.[`${THREAD_ID.A}:${interactionId("A", turn)}`] ?? null;
  }

  get prompt() { return this.window.document.querySelector("#threadPrompt"); }
  get send() { return this.window.document.querySelector("#sendInteraction"); }

  #syncState() {
    this.state.interactions = Object.entries(this.turns).flatMap(([thread, turns]) => turns.map((turn, index) => ({
      id: interactionId(thread, index + 1),
      threadId: THREAD_ID[thread],
      sequence: index + 1,
      text: turn.text ?? `Turn ${index + 1}`,
      ...(turn.latestAttempt ? { latestAttempt: turn.latestAttempt } : {}),
      graphNodeId: interactionId(thread, index + 1) + 5000,
      completionStatus: turn.status,
    })));
    const latest = this.turns[this.view].length;
    this.state.currentInteractionId = interactionId(this.view, latest);
    this.state.status = this.turns[this.view][latest - 1].status;
    // This configuration-owned fixture has no provider-native conversation state.
    this.state.conversationCompatibility = { threadId: THREAD_ID[this.view], status: "unrestricted", harnessId: "fixture" };
    this.selection.currentThreadId = THREAD_ID[this.view];
    this.selection.currentInteractionId = this.state.currentInteractionId;
  }

  #render() {
    this.#syncState();
    this.workspace.render();
  }

  // A fake threads.submitInteraction: the thread comes from the view when it
  // is called, as in TH:741.
  #submit(text) {
    this.submits = (this.submits ?? 0) + 1;
    const thread = this.view;
    const call = { text, post: deferred(), refresh: deferred(), settle: deferred(), phase: "post" };
    this.calls[thread] = call;
    return (async () => {
      try {
        await call.post.promise;
        await call.refresh.promise;
        await call.settle.promise;
        return { id: interactionId(thread, this.turns[thread].length) };
      } finally {
        call.phase = "idle";
      }
    })();
  }

  // A turn a send created carries that send's text.
  #turnArrives(thread) {
    this.turns[thread].push({ status: "running", text: this.recordedText[thread] });
    this.recordedText[thread] = undefined;
    this.pendingTurn[thread] = false;
    if (thread === this.view) this.#render();
    else this.#syncState();
  }

  async apply([name, arg]) {
    const call = arg ? this.calls[arg] : null;
    switch (name) {
      case "Type": {
        if (this.prompt.disabled) throw new Error("Type: the prompt is disabled");
        this.fresh += 1;
        this.prompt.value = textFor(this.fresh);
        this.prompt.dispatchEvent(new this.window.Event("input"));
        break;
      }
      case "Erase": {
        if (this.prompt.disabled) throw new Error("Erase: the prompt is disabled");
        this.prompt.value = "";
        this.prompt.dispatchEvent(new this.window.Event("input"));
        break;
      }
      case "ClickSend": {
        if (this.send.disabled) throw new Error("ClickSend: Send is disabled");
        this.send.click();
        break;
      }
      case "SwitchThread": {
        this.view = arg;
        if (this.pendingTurn[arg]) this.#turnArrives(arg);
        else this.#render();
        break;
      }
      case "PostInserted": {
        this.pendingTurn[arg] = true;
        this.recordedText[arg] = call.text;
        call.phase = "posted";
        break;
      }
      case "PostSucceeds": {
        call.phase = "refresh";
        call.post.resolve();
        break;
      }
      case "PostFails": {
        call.phase = "idle";
        // A definite rejection; since #719 no running turn causes one.
        call.post.reject(Object.assign(new Error("The message was rejected."), { status: 422 }));
        break;
      }
      case "PostLost": {
        call.phase = "idle";
        call.post.reject(Object.assign(new Error("The server could not be reached."), { status: 503 }));
        break;
      }
      case "RefreshReturns": {
        if (this.view === arg && this.pendingTurn[arg]) this.#turnArrives(arg);
        call.phase = "settle";
        call.refresh.resolve();
        break;
      }
      case "RefreshSkipped": {
        call.phase = "settle";
        call.refresh.resolve();
        break;
      }
      case "Settle": {
        call.settle.resolve();
        break;
      }
      case "TurnArrives": {
        this.#turnArrives(arg);
        break;
      }
      case "InvokeTurn": {
        // A turn created elsewhere in the thread, such as by an authored invoke.
        this.turns[arg].push({ status: "running", text: "Invoked" });
        if (arg === this.view) this.#render();
        else this.#syncState();
        break;
      }
      case "TurnFinishes": {
        this.turns[arg].at(-1).status = "accepted";
        if (arg === this.view) this.#render();
        else this.#syncState();
        break;
      }
      case "BackgroundRender": {
        this.#render();
        break;
      }
      default:
        throw new Error(`Unknown TurnComposer action ${name}`);
    }
    await settle();
  }

  // The refinement mapping onto the spec's observable variables.
  observe() {
    const nullText = this.maxText + 1;
    const persisted = {};
    for (const thread of Object.keys(THREAD_ID)) {
      for (let turn = 1; turn <= this.maxTurns; turn += 1) {
        const value = threadFollowupDraft(`${THREAD_ID[thread]}:${interactionId(thread, turn)}`);
        persisted[`<<"${thread}", ${turn}>>`] = value === null ? nullText : identityOf(value);
      }
    }
    return {
      view: specThread(this.selection.currentThreadId),
      latest: { A: this.turns.A.length, B: this.turns.B.length },
      running: { A: this.turns.A.at(-1).status === "running", B: this.turns.B.at(-1).status === "running" },
      pendingTurn: { ...this.pendingTurn },
      text: identityOf(this.prompt.value),
      disabled: this.prompt.disabled,
      persisted,
      pc: { A: this.calls.A?.phase ?? "idle", B: this.calls.B?.phase ?? "idle" },
    };
  }

  dispose() {
    this.workspace.dispose();
    vi.unstubAllGlobals();
  }
}

// The same projection of a trace state.
export function projectModelState(state) {
  return {
    view: state.view,
    latest: state.latest,
    running: state.running,
    pendingTurn: state.pendingTurn,
    text: state.text,
    disabled: state.disabled,
    persisted: state.persisted,
    pc: state.pc,
  };
}

const values = (set) => Object.values(set ?? {});

// Promises over the real observation and the trace's ghost variables (what
// the user typed and what a successful POST carried). They can be checked
// only for the thread on screen: another thread's composer is internal state
// until the user returns to it.
export const PROMISES = {
  UnsentDraftSurvives: (real, model) => {
    const t = real.view;
    const sending = model.pc[t] !== "idle" && model.intent[t].text === model.unsent[t];
    return model.unsent[t] === 0 || sending || real.text === model.unsent[t];
  },
  SupersededStaysGone: (real, model) => real.text === 0 || !values(model.superseded).includes(real.text),
  SettlementClearsOnlySentText: (_real, model) => model.cleared === 0 || values(model.sent).includes(model.cleared),
  // A send that may have been sent leaves its text in the prompt of the
  // scope it was sent from (SCP-019).
  SentTextIsNotShownAgain: (real, model) => model.pc[real.view] !== "idle"
    || real.text === 0 || !values(model.sent).includes(real.text)
    || values(model.uncertainAt).some((held) => held.text === real.text
      && held.scope["1"] === real.view && held.scope["2"] === model.latest[real.view]),
};
