import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AuthoredInputSendWorld,
  PROMISES,
  projectModelState,
} from "./support/authored-input-send-trace-adapter.mjs";

// Scenario traces rendered from models/tla/AuthoredInputSend.tla (see
// models/tla/README.md). Each step replays against the real Product
// workspace, its authored Node Detail input, and its input draft controller
// in happy-dom, with a fake app server applying the storage rules. The real
// requests must match the model after every step. A promise in
// violatedAtEnd is an open bug that breaks at the final step.
const traceDirectory = join(import.meta.dirname, "..", "models", "tla", "traces");
const traces = readdirSync(traceDirectory)
  .filter((file) => file.endsWith(".json"))
  .map((file) => JSON.parse(readFileSync(join(traceDirectory, file), "utf8")))
  .filter((trace) => trace.module === "AuthoredInputSend");

const describeStep = (action) => (action ? action.join(" ") : "initial state");
let world;

afterEach(() => {
  world?.dispose();
  world = null;
});

describe("AuthoredInputSend traces replay against the Product workspace", () => {
  it("has traces to replay", () => {
    expect(traces.length).toBeGreaterThan(0);
  });

  for (const trace of traces) {
    it(`${trace.scenario}: ${trace.summary}`, async () => {
      world = await new AuthoredInputSendWorld().ready();
      const last = trace.steps.length - 1;
      for (const [index, { action, state }] of trace.steps.entries()) {
        if (action) await world.apply(action);
        const where = `step ${index} (${describeStep(action)})`;
        expect(world.observe(), `${where}: real state diverges from the model`).toEqual(projectModelState(state));
        for (const promise of trace.promises) {
          expect(PROMISES[promise](world, state), `${where}: ${promise} is broken`).toBe(true);
        }
        for (const promise of trace.violatedAtEnd ?? []) {
          expect(PROMISES[promise](world, state), `${where}: ${promise} ${index === last ? "no longer breaks; the bug is fixed" : "breaks early"}`)
            .toBe(index !== last);
        }
      }
    });
  }
});

// TurnComposer.tla's ClickSendWaits, InvokeTurn, then Reconciled or
// ReconcileEnds: a Send waits on an authored input commit while a turn
// created elsewhere in the thread arrives. The composer adapter has no
// authored input to hold a Send on, so these run in this world.
describe("A newer turn arriving while Send waits for an authored commit", () => {
  const COMPOSED = "Here is my answer";

  it("does not carry the text being sent into the newer turn", async () => {
    world = await new AuthoredInputSendWorld().ready();
    for (const step of [["Type", 1], ["Commit"], ["ClickSend"]]) await world.apply(step);
    await world.newerTurnArrives();
    expect(world.promptText).toBe("");
    for (const step of [["ServeCommit"], ["CommitReturns"], ["ServeSend"], ["SendReturns"]]) {
      await world.apply(step);
    }
    expect(world.sentWith).toBe(1);
    expect(world.promptText).toBe("");
  });

  for (const typed of ["before", "after"]) {
    it(`keeps the sent text retyped in the newer turn ${typed} the POST starts, once the sent turn loads`, async () => {
      world = await new AuthoredInputSendWorld().ready();
      for (const step of [["Type", 1], ["Commit"], ["ClickSend"]]) await world.apply(step);
      if (typed === "after") for (const step of [["ServeCommit"], ["CommitReturns"]]) await world.apply(step);
      await world.newerTurnArrives({ invoked: true });
      await world.typePrompt(COMPOSED);
      if (typed === "before") for (const step of [["ServeCommit"], ["CommitReturns"]]) await world.apply(step);
      for (const step of [["ServeSend"], ["SendReturns"]]) await world.apply(step);
      await world.newerTurnArrives({ text: COMPOSED, id: 7 });
      expect(world.promptText).toBe(COMPOSED);
    });
  }

  it("keeps the retyped text a second newer turn carried on while Send waited", async () => {
    world = await new AuthoredInputSendWorld().ready();
    for (const step of [["Type", 1], ["Commit"], ["ClickSend"]]) await world.apply(step);
    await world.newerTurnArrives({ invoked: true });
    await world.typePrompt(COMPOSED);
    await world.newerTurnArrives({ invoked: true, id: 7 });
    expect(world.promptText).toBe(COMPOSED);
    for (const step of [["ServeCommit"], ["CommitReturns"], ["ServeSend"], ["SendReturns"]]) await world.apply(step);
    await world.newerTurnArrives({ text: COMPOSED, id: 8 });
    expect(world.promptText).toBe(COMPOSED);
  });

  it("keeps text typed since then, and does not restore the older text", async () => {
    world = await new AuthoredInputSendWorld().ready();
    for (const step of [["Type", 1], ["Commit"], ["ClickSend"]]) await world.apply(step);
    await world.newerTurnArrives();
    await world.typePrompt("second thought");
    for (const step of [["CommitFails"], ["CommitReturns"]]) await world.apply(step);
    expect(world.post).toBeNull();
    expect(world.promptText).toBe("second thought");
  });

  it("leaves text the user cleared while the Send waited cleared when it stops", async () => {
    world = await new AuthoredInputSendWorld().ready();
    for (const step of [["Type", 1], ["Commit"], ["ClickSend"]]) await world.apply(step);
    await world.typePrompt("");
    for (const step of [["CommitFails"], ["CommitReturns"]]) await world.apply(step);
    expect(world.post).toBeNull();
    expect(world.promptText).toBe("");
  });

  it("counts text retyped while the Send waited as an edit after that Send", async () => {
    world = await new AuthoredInputSendWorld().ready();
    for (const step of [["Type", 1], ["Commit"], ["ClickSend"]]) await world.apply(step);
    await world.typePrompt("");
    await world.typePrompt(COMPOSED);
    for (const step of [["ServeCommit"], ["CommitReturns"]]) await world.apply(step);
    expect(world.post).not.toBeNull();
    expect(world.sentRecord()).toMatchObject({ edited: true });
  });

  it("hands the text back when that Send stops", async () => {
    world = await new AuthoredInputSendWorld().ready();
    for (const step of [["Type", 1], ["Commit"], ["ClickSend"]]) await world.apply(step);
    await world.newerTurnArrives();
    for (const step of [["CommitFails"], ["CommitReturns"]]) await world.apply(step);
    expect(world.post).toBeNull();
    expect(world.promptText).toBe(COMPOSED);
  });
});

describe("Send after an answer did not save", () => {
  it("is stopped once when leaving the field refuses a blank answer", async () => {
    world = await new AuthoredInputSendWorld().ready();
    for (const step of [["Type", 1], ["Commit"], ["ServeCommit"], ["CommitReturns"], ["Type", 0]]) await world.apply(step);
    // Pressing Send leaves the field, which refuses the blank answer.
    world.input.dispatchEvent(new world.window.Event("change", { bubbles: true }));
    await world.click("#sendInteraction");
    expect(world.post).toBeNull();
    await world.click("#sendInteraction");
    expect(world.post).not.toBeNull();
  });

  it("is stopped by a refused answer even after another Node Detail's input with its mount ID is edited", async () => {
    world = await new AuthoredInputSendWorld({ otherNode: true }).ready();
    world.input.value = " ";
    world.input.dispatchEvent(new world.window.Event("change", { bubbles: true }));
    await world.settled();
    await world.openNode(8, "Other answer");
    world.input.value = "unrelated";
    world.input.dispatchEvent(new world.window.Event("input", { bubbles: true }));
    await world.settled();
    await world.click("#sendInteraction");
    expect(world.post).toBeNull();
  });

  it("is not stopped by a refused answer once its input is detached", async () => {
    world = await new AuthoredInputSendWorld().ready();
    for (const step of [["Type", 1], ["Commit"], ["ServeCommit"], ["CommitReturns"], ["Type", 0]]) await world.apply(step);
    world.input.dispatchEvent(new world.window.Event("change", { bubbles: true }));
    await world.settled();
    world.acceptDetach();
    await world.click('[aria-label="Detach Your answer"]');
    expect(world.detachRequests).toHaveBeenCalled();
    await world.click("#sendInteraction");
    expect(world.post).not.toBeNull();
  });

  it("is not stopped by a refused answer the user has since corrected and committed", async () => {
    world = await new AuthoredInputSendWorld().ready();
    await world.apply(["Type", 1]);
    world.input.value = " ";
    world.input.dispatchEvent(new world.window.Event("input", { bubbles: true }));
    world.input.dispatchEvent(new world.window.Event("change", { bubbles: true }));
    await world.settled();
    for (const step of [["Type", 2], ["Commit"], ["ServeCommit"], ["CommitReturns"]]) await world.apply(step);
    await world.click("#sendInteraction");
    expect(world.post).not.toBeNull();
  });

  it("is not stopped by a refusal a later change committed past, with no edit between", async () => {
    world = await new AuthoredInputSendWorld().ready();
    world.input.value = " ";
    world.input.dispatchEvent(new world.window.Event("change", { bubbles: true }));
    await world.settled();
    // A select reports its change with no input event before it.
    world.input.value = "answer 2";
    world.input.dispatchEvent(new world.window.Event("change", { bubbles: true }));
    await world.settled();
    expect(world.put).not.toBeNull();
    for (const step of [["ServeCommit"], ["CommitReturns"]]) await world.apply(step);
    await world.click("#sendInteraction");
    expect(world.post).not.toBeNull();
  });

  it("is stopped once even after that Node Detail was closed, then sends", async () => {
    world = await new AuthoredInputSendWorld().ready();
    for (const step of [["Type", 1], ["Commit"], ["CommitFails"], ["CommitReturns"]]) await world.apply(step);
    await world.click("#closeInspector");
    await world.click("#sendInteraction");
    expect(world.post).toBeNull();
    await world.click("#sendInteraction");
    expect(world.post).not.toBeNull();
  });

  it("stops when that answer was all there was to send", async () => {
    world = await new AuthoredInputSendWorld().ready();
    await world.typePrompt("");
    for (const step of [["Type", 1], ["Commit"]]) await world.apply(step);
    await world.click("#closeInspector");
    expect(world.window.document.querySelector("#sendInteraction").disabled).toBe(false);
    await world.click("#sendInteraction");
    for (const step of [["CommitFails"], ["CommitReturns"]]) await world.apply(step);
    expect(world.post).toBeNull();
  });
});

// Not in AuthoredInputSend.tla, which models the authored input.
describe("An ordinary Node Details input committing when Send is clicked", () => {
  it("lets that Send wait for the answer and carry it", async () => {
    world = await new AuthoredInputSendWorld({ authored: false }).ready();
    for (const step of [["Type", 1], ["Commit"]]) await world.apply(step);
    expect(world.window.document.querySelector("#sendInteraction").disabled).toBe(false);
    await world.click("#sendInteraction");
    expect(world.post).toBeNull();
    for (const step of [["ServeCommit"], ["CommitReturns"], ["ServeSend"], ["SendReturns"]]) await world.apply(step);
    expect(world.sentWith).toBe(1);
  });

  it("stops that Send when the answer does not save", async () => {
    world = await new AuthoredInputSendWorld({ authored: false }).ready();
    for (const step of [["Type", 1], ["Commit"]]) await world.apply(step);
    await world.click("#sendInteraction");
    for (const step of [["CommitFails"], ["CommitReturns"]]) await world.apply(step);
    expect(world.post).toBeNull();
    expect(world.promptText).toBe("Here is my answer");
  });

  it("stops no later Send once Undo discards the answer that failed", async () => {
    world = await new AuthoredInputSendWorld({ authored: false }).ready();
    for (const step of [["Type", 1], ["Commit"], ["CommitFails"], ["CommitReturns"]]) await world.apply(step);
    await world.click('#nodeInputActions [data-input-control-role="undo"]');
    await world.click("#sendInteraction");
    expect(world.post).not.toBeNull();
  });
});

// AuthoredInputSend.tla assumes the prompt holds text.
describe("An authored answer typed but not committed, with an empty composer", () => {
  const sendDisabled = () => world.window.document.querySelector("#sendInteraction").disabled;

  it("makes Send ready, and the Send that leaving the field commits carries it", async () => {
    world = await new AuthoredInputSendWorld().ready();
    await world.typePrompt("");
    expect(sendDisabled()).toBe(true);
    await world.apply(["Type", 1]);
    expect(sendDisabled()).toBe(false);
    // Pressing Send leaves the field first, which fires change.
    world.input.dispatchEvent(new world.window.Event("change", { bubbles: true }));
    expect(sendDisabled()).toBe(false);
    await world.click("#sendInteraction");
    for (const step of [["ServeCommit"], ["CommitReturns"], ["ServeSend"], ["SendReturns"]]) await world.apply(step);
    expect(world.sentWith).toBe(1);
  });

  it("stops counting once the field is left without a change, cleared, or closed", async () => {
    world = await new AuthoredInputSendWorld().ready();
    await world.typePrompt("");
    await world.apply(["Type", 1]);
    world.input.dispatchEvent(new world.window.Event("blur"));
    await world.settled();
    expect(sendDisabled()).toBe(true);
    await world.apply(["Type", 2]);
    expect(sendDisabled()).toBe(false);
    await world.apply(["Type", 0]);
    expect(sendDisabled()).toBe(true);
    await world.apply(["Type", 2]);
    await world.click("#closeInspector");
    expect(sendDisabled()).toBe(true);
  });

  it("counts an answer typed while its Node Detail's assets load", async () => {
    world = await new AuthoredInputSendWorld({ slowAsset: true }).ready();
    await world.typePrompt("");
    await world.apply(["Type", 1]);
    await world.loadAsset();
    expect(sendDisabled()).toBe(false);
  });

  it("stops the Send when leaving the field commits nothing", async () => {
    world = await new AuthoredInputSendWorld().ready();
    await world.typePrompt("");
    await world.apply(["Type", 1]);
    // Input editing is unavailable once the turn has no graph node.
    world.state.interactions[0].graphNodeId = null;
    world.input.dispatchEvent(new world.window.Event("change", { bubbles: true }));
    await world.click("#sendInteraction");
    expect(world.put).toBeNull();
    expect(world.post).toBeNull();
  });
});

describe("An answer that failed while its Node Detail was replaced", () => {
  it("shows a refused answer's error again, until the input is edited", async () => {
    world = await new AuthoredInputSendWorld({ otherNode: true }).ready();
    world.input.value = " ";
    world.input.dispatchEvent(new world.window.Event("change", { bubbles: true }));
    await world.settled();
    const revisit = async () => {
      await world.openNode(8, "Other answer");
      await world.openNode(7, "Your answer");
    };
    await revisit();
    expect(world.input?.getAttribute("aria-invalid")).toBe("true");
    await world.apply(["Type", 2]);
    await revisit();
    expect(world.input?.getAttribute("aria-invalid")).not.toBe("true");
  });

  it("shows the failure again when the input is shown", async () => {
    world = await new AuthoredInputSendWorld().ready();
    for (const step of [["Type", 1], ["Commit"]]) await world.apply(step);
    await world.newerTurnArrives();
    for (const step of [["CommitFails"], ["CommitReturns"]]) await world.apply(step);
    await world.openNode(7, "Your answer");
    expect(world.input?.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("A follow-up the server rejects outright", () => {
  it("comes back even when an invoke made a turn with the same text meanwhile", async () => {
    world = await new AuthoredInputSendWorld().ready();
    await world.click("#sendInteraction");
    await world.newerTurnArrives({ text: "Here is my answer", invoked: true });
    world.post.response.reject(Object.assign(new Error("interaction_in_progress"), { status: 409 }));
    await world.settled();
    expect(world.promptText).toBe("Here is my answer");
  });
});

describe("Committed-input pills while Send waits", () => {
  it("cannot detach an answer the Send will reserve", async () => {
    world = await new AuthoredInputSendWorld().ready();
    for (const step of [["Type", 1], ["Commit"], ["ServeCommit"], ["CommitReturns"], ["Type", 2], ["Commit"]]) {
      await world.apply(step);
    }
    await world.click("#closeInspector");
    await world.click("#sendInteraction");
    await world.click('[aria-label="Detach Your answer"]');
    // A detach would be queued behind the commit, so let the commit land.
    for (const step of [["ServeCommit"], ["CommitReturns"]]) await world.apply(step);
    expect(world.detachRequests).not.toHaveBeenCalled();
  });
});

describe("A follow-up whose POST fails with a server error", () => {
  it("keeps its text in the composer when an unrelated newer turn arrives", async () => {
    world = await new AuthoredInputSendWorld().ready();
    await world.click("#sendInteraction");
    world.post.response.reject(Object.assign(new Error("The server could not be reached."), { status: 503 }));
    await world.settled();
    expect(world.promptText).toBe("Here is my answer");
    await world.newerTurnArrives();
    expect(world.promptText).toBe("Here is my answer");
  });
});

// Not in TurnComposer.tla, which leaves out the draft-send warning.
describe("The draft-send warning", () => {
  const draft = {
    id: "d1", threadId: 3, target: { nodeId: 7 }, targetNode: { title: "Question" }, text: "note",
    revision: 1, createdAt: "2026-09-27T00:00:00Z", updatedAt: "2026-09-27T00:00:00Z",
  };

  it("holds the text while open, and hands it back when cancelled after a newer turn", async () => {
    world = await new AuthoredInputSendWorld({ contextDrafts: [draft] }).ready();
    const dialog = world.window.document.querySelector("#contextDraftSendWarning");
    dialog.showModal ??= function showModal() { this.open = true; };
    dialog.close ??= function close() { this.open = false; };
    // No node is selected, so nothing re-renders the composer afterwards.
    await world.click("#closeInspector");
    await world.click("#sendInteraction");
    expect(dialog.open).toBe(true);
    await world.newerTurnArrives();
    expect(world.promptText).toBe("");
    await world.click("#cancelContextDraftSend");
    expect(world.post).toBeNull();
    expect(world.promptText).toBe("Here is my answer");
    expect(world.window.document.querySelector("#sendInteraction").disabled).toBe(false);
  });
});
