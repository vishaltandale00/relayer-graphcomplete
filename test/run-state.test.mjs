import { describe, expect, it } from "vitest";

import { interactionActivity, nodeActiveRuns, nodeRunState, threadActivity } from "../desktop/renderer/src/product-workspace/run-state.js";

describe("explicit run-state symbols", () => {
  it("derives a thread's symbol from its latest interaction like the app server does", () => {
    const activity = (completionStatus, stop = {}) => interactionActivity({ completionStatus, ...stop });
    expect(["not_started", "submitted", "running", "waiting_for_approval", "failed", "accepted", "stopped", "cancelled"].map((status) => activity(status)))
      .toEqual(["running", "running", "running", "needs_approval", "failed", null, null, null]);
    expect(activity("running", { stopRequested: true })).toBe("stopping");
    expect(activity("waiting_for_approval", { stopRequested: true })).toBe("stopping");
    expect(activity("running", { stopRequested: true, stopError: "Could not stop" })).toBe("running");
    expect(interactionActivity(undefined)).toBeNull();
  });

  it("shows a thread's most urgent human turn, not only its latest", () => {
    const turn = (completionStatus, extra = {}) => ({ completionStatus, ...extra });
    // An earlier turn that needs approval stays visible after a later run is accepted.
    expect(threadActivity([turn("waiting_for_approval"), turn("accepted")])).toBe("needs_approval");
    expect(threadActivity([turn("running"), turn("running", { stopRequested: true })])).toBe("stopping");
    expect(threadActivity([turn("running"), turn("accepted")])).toBe("running");
    expect(threadActivity([turn("accepted"), turn("failed")])).toBe("failed");
    expect(threadActivity([turn("failed"), turn("accepted")])).toBeNull();
    // A run a model failure returned to unsent is not running.
    expect(threadActivity([turn("not_started", { latestAttempt: { outcome: "model_failed" } })])).toBeNull();
    expect(threadActivity([])).toBeNull();
  });

  it("marks a node as draft, or with the latest child run its actions started", () => {
    const node = { id: 1 };
    const actions = [{ id: 10, sourceNodeId: 1 }, { id: 11, sourceNodeId: 1 }, { id: 20, sourceNodeId: 2 }];
    const invocation = (actionId, resultInteractionId, resultCompletionStatus) => ({ actionId, resultInteractionId, resultCompletionStatus });
    expect(nodeRunState({ id: 1, state: "draft" }, actions, [invocation(10, 5, "running")])).toBe("draft");
    expect(nodeRunState(node, actions, [])).toBeNull();
    expect(nodeRunState(node, actions, [invocation(10, 5, "accepted")])).toBeNull();
    expect(nodeRunState(node, actions, [invocation(10, 5, "failed"), invocation(11, 6, "running")])).toBe("running");
    // Runs from one node run at once: an older run still running keeps the node running.
    expect(nodeRunState(node, actions, [invocation(10, 7, "stopped"), invocation(11, 6, "running")])).toBe("running");
    expect(nodeRunState(node, actions, [invocation(10, 7, "stopped"), invocation(11, 6, "accepted")])).toBe("stopped");
    // A model failure returned the run to unsent: it is not running, and it failed.
    const returned = { id: 6, completionStatus: "not_started", latestAttempt: { outcome: "model_failed" } };
    expect(nodeRunState(node, actions, [invocation(11, 6, "not_started")], [returned])).toBe("failed");
    expect(nodeRunState(node, actions, [invocation(11, 6, "not_started")])).toBe("running");
    expect(nodeRunState(node, actions, [invocation(11, 6, "failed")])).toBe("failed");
    expect(nodeRunState(node, actions, [invocation(20, 9, "running")])).toBeNull();
  });

  it("gives every active run a person started from the node its own Stop", () => {
    const node = { id: 1 };
    const actions = [{ id: 10, sourceNodeId: 1 }, { id: 11, sourceNodeId: 1 }, { id: 20, sourceNodeId: 2 }];
    const invocation = (actionId, resultInteractionId, resultCompletionStatus, agentInvoked = false) => ({
      actionId, resultInteractionId, resultCompletionStatus, agentInvoked,
    });
    const run = (id, completionStatus, extra = {}) => ({ id, completionStatus, ...extra });
    const ids = (runs) => runs.map(({ run: active }) => active.id);
    // The product row wins over the invocation summary, which can lag behind it.
    expect(nodeActiveRuns(node, actions, [invocation(10, 5, "accepted"), invocation(11, 6, "not_started")], [run(6, "running")]))
      .toEqual([{ invocation: invocation(11, 6, "not_started"), run: run(6, "running") }]);
    expect(nodeActiveRuns(node, actions, [invocation(11, 6, "running")], [run(6, "accepted")])).toEqual([]);
    // A newer run that already ended never hides an older one still running; both running runs show.
    expect(ids(nodeActiveRuns(node, actions, [invocation(10, 5, "running"), invocation(11, 6, "failed")]))).toEqual([5]);
    expect(ids(nodeActiveRuns(node, actions, [invocation(11, 6, "running"), invocation(10, 5, "waiting_for_approval")]))).toEqual([5, 6]);
    // A run a model failure returned to unsent is retried from its action, not stopped.
    expect(nodeActiveRuns(node, actions, [invocation(11, 6, "not_started")], [run(6, "not_started", { latestAttempt: { outcome: "model_failed" } })]))
      .toEqual([]);
    // Only its parent agent stops an agent's child; another node's run is not this node's.
    expect(nodeActiveRuns(node, actions, [invocation(11, 6, "running", true)], [run(6, "running")])).toEqual([]);
    expect(nodeActiveRuns(node, actions, [invocation(20, 9, "running")])).toEqual([]);
  });
});
