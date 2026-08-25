import { describe, expect, it } from "vitest";

import {
  ONBOARDING_TUTORIAL_PROMPT,
  createOnboardingTutorialState,
  reduceOnboardingTutorial,
  selectOnboardingTutorialAction,
} from "../desktop/renderer/src/onboarding-tutorial-state.js";

const acceptedLayer = ({ actions = [] } = {}) => ({
  layer: { id: "layer-1" },
  nodes: [
    { id: "node-1", title: "Attention" },
    { id: "node-2", title: "Memory" },
  ],
  actions,
});

function advance(current, event) {
  return reduceOnboardingTutorial(current, event);
}

describe("onboarding tutorial state", () => {
  it("starts with the ordinary editable question and waits for successful thread creation", () => {
    const initial = createOnboardingTutorialState();

    expect(ONBOARDING_TUTORIAL_PROMPT).toBe("Why can time seem to pass faster as we get older?");
    expect(initial).toEqual({
      phase: "initial-composer",
      threadId: null,
      interactionId: null,
      target: null,
      reason: null,
    });
    expect(advance(initial, { type: "response-accepted", layer: acceptedLayer() })).toBe(initial);
    expect(advance(initial, {
      type: "thread-created",
      threadId: "thread-7",
      interactionId: "turn-1",
    })).toEqual({
      phase: "awaiting-accepted-response",
      threadId: "thread-7",
      interactionId: "turn-1",
      target: null,
      reason: null,
    });
  });

  it("prioritizes a node-linked navigate action over earlier invoke actions", () => {
    const layer = acceptedLayer({ actions: [
      { id: "invoke-1", kind: "invoke", sourceNodeId: "node-1" },
      { id: "navigate-1", kind: "navigate", sourceNodeId: "node-2", targetLayerId: 2 },
      { id: "navigate-orphan", kind: "navigate", sourceNodeId: "missing-node", targetLayerId: 3 },
    ] });

    expect(selectOnboardingTutorialAction(layer)).toEqual({
      nodeId: "node-2",
      actionId: "navigate-1",
      actionKind: "navigate",
    });
  });

  it("excludes malformed, invoked, and disabled actions before choosing a fallback", () => {
    const layer = acceptedLayer({ actions: [
      { id: "navigate-missing-target", kind: "navigate", sourceNodeId: "node-1" },
      { kind: "navigate", sourceNodeId: "node-1", targetLayerId: 2 },
      { id: "navigate-invoked", kind: "navigate", sourceNodeId: "node-1", targetLayerId: 3 },
      { id: "invoke-disabled", kind: "invoke", sourceNodeId: "node-1", interactionText: "One" },
      { id: "invoke-empty", kind: "invoke", sourceNodeId: "node-1", interactionText: "  " },
      { id: "invoke-ready", kind: "invoke", sourceNodeId: "node-2", interactionText: "Two" },
    ] });

    expect(selectOnboardingTutorialAction(layer, {
      invokedActionIds: ["navigate-invoked"],
      disabledActionIds: new Set(["invoke-disabled"]),
    })).toEqual({
      nodeId: "node-2",
      actionId: "invoke-ready",
      actionKind: "invoke",
    });
  });

  it("excludes resolved invokes before choosing an invoke fallback", () => {
    const layer = acceptedLayer({ actions: [
      {
        id: "invoke-resolved",
        kind: "invoke",
        sourceNodeId: "node-1",
        targetLayerId: "layer-2",
        interactionText: "Already explored",
      },
      {
        id: "invoke-ready",
        kind: "invoke",
        sourceNodeId: "node-2",
        targetLayerId: null,
        interactionText: "Explore next",
      },
    ] });

    expect(selectOnboardingTutorialAction(layer)).toEqual({
      nodeId: "node-2",
      actionId: "invoke-ready",
      actionKind: "invoke",
    });
  });

  it("guides node selection, navigation, and a user-written follow-up", () => {
    let tutorial = createOnboardingTutorialState();
    tutorial = advance(tutorial, { type: "thread-created", threadId: 7, interactionId: 11 });
    tutorial = advance(tutorial, {
      type: "response-accepted",
      threadId: 7,
      interactionId: 11,
      layer: acceptedLayer({ actions: [
        { id: 31, kind: "navigate", sourceNodeId: "node-2", targetLayerId: 20 },
      ] }),
    });
    expect(tutorial.phase).toBe("select-node");

    const wrongNode = advance(tutorial, {
      type: "node-selected", threadId: 7, interactionId: 11, nodeId: "node-1",
    });
    expect(wrongNode).toBe(tutorial);
    tutorial = advance(tutorial, {
      type: "node-selected", threadId: 7, interactionId: 11, nodeId: "node-2",
    });
    expect(tutorial.phase).toBe("use-action");

    const wrongAction = advance(tutorial, {
      type: "action-succeeded", threadId: 7, interactionId: 11, actionId: 99,
    });
    expect(wrongAction).toBe(tutorial);
    tutorial = advance(tutorial, {
      type: "action-succeeded", threadId: 7, interactionId: 11, actionId: "31",
    });
    expect(tutorial.phase).toBe("write-follow-up");
    expect(tutorial.target).toBeNull();

    tutorial = advance(tutorial, { type: "followup-submitted" });
    expect(tutorial.phase).toBe("write-follow-up");
    tutorial = advance(tutorial, { type: "followup-submitted", threadId: "7", interactionId: 12 });
    expect(tutorial).toEqual({
      phase: "complete",
      threadId: 7,
      interactionId: 12,
      target: null,
      reason: null,
    });
  });

  it.each([
    ["closes", null],
    ["changes", "node-1"],
  ])("returns to node selection when the inspector %s during action guidance", (_label, nodeId) => {
    let tutorial = createOnboardingTutorialState();
    tutorial = advance(tutorial, { type: "thread-created", threadId: 7, interactionId: 11 });
    tutorial = advance(tutorial, {
      type: "response-accepted",
      threadId: 7,
      interactionId: 11,
      layer: acceptedLayer({ actions: [
        { id: 31, kind: "navigate", sourceNodeId: "node-2", targetLayerId: 20 },
      ] }),
    });
    tutorial = advance(tutorial, {
      type: "node-selected", threadId: 7, interactionId: 11, nodeId: "node-2",
    });
    expect(tutorial.phase).toBe("use-action");

    tutorial = advance(tutorial, {
      type: "node-selected", threadId: 7, interactionId: 11, nodeId,
    });

    expect(tutorial.phase).toBe("select-node");
    expect(tutorial.target).toEqual({
      nodeId: "node-2",
      actionId: 31,
      actionKind: "navigate",
    });
  });

  it("uses an invoke fallback but still requires eventual navigation", () => {
    let tutorial = advance(createOnboardingTutorialState(), {
      type: "thread-created",
      threadId: 7,
      interactionId: 11,
    });
    tutorial = advance(tutorial, {
      type: "response-accepted",
      threadId: 7,
      interactionId: 11,
      layer: acceptedLayer({ actions: [
        { id: "invoke-1", kind: "invoke", sourceNodeId: "node-1", interactionText: "Go deeper" },
      ] }),
    });
    tutorial = advance(tutorial, {
      type: "node-selected", threadId: 7, interactionId: 11, nodeId: "node-1",
    });
    tutorial = advance(tutorial, {
      type: "action-succeeded",
      threadId: 7,
      interactionId: 11,
      actionId: "invoke-1",
      resultInteractionId: 12,
    });
    expect(tutorial.phase).toBe("awaiting-accepted-response");
    expect(tutorial.interactionId).toBe(12);

    tutorial = advance(tutorial, {
      type: "response-accepted",
      threadId: 7,
      interactionId: 12,
      layer: acceptedLayer({ actions: [
        { id: "navigate-2", kind: "navigate", sourceNodeId: "node-2", targetLayerId: 20 },
      ] }),
    });
    tutorial = advance(tutorial, {
      type: "node-selected", threadId: 7, interactionId: 12, nodeId: "node-2",
    });
    tutorial = advance(tutorial, {
      type: "action-succeeded", threadId: 7, interactionId: 12, actionId: "navigate-2",
    });
    expect(tutorial.phase).toBe("write-follow-up");
  });

  it("can repeat invoke guidance until a later accepted interaction offers navigation", () => {
    let tutorial = advance(createOnboardingTutorialState(), {
      type: "thread-created",
      threadId: 7,
      interactionId: 11,
    });
    for (const [sourceInteractionId, resultInteractionId, actionId] of [
      [11, 12, "invoke-1"],
      [12, 13, "invoke-2"],
    ]) {
      tutorial = advance(tutorial, {
        type: "response-accepted",
        threadId: 7,
        interactionId: sourceInteractionId,
        layer: acceptedLayer({ actions: [{
          id: actionId,
          kind: "invoke",
          sourceNodeId: "node-1",
          interactionText: "Continue",
        }] }),
      });
      tutorial = advance(tutorial, {
        type: "node-selected",
        threadId: 7,
        interactionId: sourceInteractionId,
        nodeId: "node-1",
      });
      tutorial = advance(tutorial, {
        type: "action-succeeded",
        threadId: 7,
        interactionId: sourceInteractionId,
        actionId,
        resultInteractionId,
      });
      expect(tutorial.interactionId).toBe(resultInteractionId);
    }

    tutorial = advance(tutorial, {
      type: "response-accepted",
      threadId: 7,
      interactionId: 13,
      layer: acceptedLayer({ actions: [{
        id: "navigate-3",
        kind: "navigate",
        sourceNodeId: "node-2",
        targetLayerId: 20,
      }] }),
    });
    expect(tutorial.phase).toBe("select-node");
    expect(tutorial.target.actionKind).toBe("navigate");
  });

  it("ignores stale accepted interactions after an invoke", () => {
    let tutorial = advance(createOnboardingTutorialState(), {
      type: "thread-created",
      threadId: 7,
      interactionId: 11,
    });
    tutorial = advance(tutorial, {
      type: "response-accepted",
      threadId: 7,
      interactionId: 11,
      layer: acceptedLayer({ actions: [{
        id: "invoke-1",
        kind: "invoke",
        sourceNodeId: "node-1",
        interactionText: "Continue",
      }] }),
    });
    tutorial = advance(tutorial, {
      type: "node-selected", threadId: 7, interactionId: 11, nodeId: "node-1",
    });
    tutorial = advance(tutorial, {
      type: "action-succeeded",
      threadId: 7,
      interactionId: 11,
      actionId: "invoke-1",
      resultInteractionId: 12,
    });

    const stale = advance(tutorial, {
      type: "response-accepted",
      threadId: 7,
      interactionId: 11,
      layer: acceptedLayer({ actions: [{
        id: "navigate-stale",
        kind: "navigate",
        sourceNodeId: "node-2",
        targetLayerId: 20,
      }] }),
    });
    expect(stale).toBe(tutorial);
  });

  it("dismisses an accepted response with no node-linked action", () => {
    const waiting = advance(createOnboardingTutorialState(), {
      type: "thread-created",
      threadId: 7,
      interactionId: 11,
    });
    const dismissed = advance(waiting, {
      type: "response-accepted",
      threadId: 7,
      interactionId: 11,
      layer: acceptedLayer({ actions: [
        { id: "orphan", kind: "navigate", sourceNodeId: "missing-node", targetLayerId: 2 },
      ] }),
    });

    expect(dismissed).toEqual({
      phase: "dismissed",
      threadId: 7,
      interactionId: 11,
      target: null,
      reason: "no-action",
    });
  });

  it.each(["failed", "cancelled", "stopped"])(
    "dismisses when the awaited response becomes %s",
    (status) => {
      const waiting = advance(createOnboardingTutorialState(), {
        type: "thread-created",
        threadId: 7,
        interactionId: 11,
      });
      const stale = advance(waiting, {
        type: "response-terminal",
        threadId: 8,
        interactionId: 11,
        status,
      });
      expect(stale).toBe(waiting);

      expect(advance(waiting, {
        type: "response-terminal",
        threadId: 7,
        interactionId: 11,
        status,
      })).toEqual({
        phase: "dismissed",
        threadId: 7,
        interactionId: 11,
        target: null,
        reason: `response-${status}`,
      });
    },
  );

  it.each([
    ["skip", "skipped"],
    ["leave", "left"],
    ["close", "closed"],
  ])("lets %s end the tutorial without changing the thread", (type, reason) => {
    const active = advance(
      advance(createOnboardingTutorialState(), {
        type: "thread-created",
        threadId: 7,
        interactionId: 11,
      }),
      {
        type: "response-accepted",
        threadId: 7,
        interactionId: 11,
        layer: acceptedLayer({ actions: [
          { id: 31, kind: "navigate", sourceNodeId: "node-2", targetLayerId: 20 },
        ] }),
      },
    );

    expect(advance(active, { type })).toEqual({
      phase: "dismissed",
      threadId: 7,
      interactionId: 11,
      target: null,
      reason,
    });
  });

  it("keeps terminal states terminal", () => {
    const dismissed = advance(createOnboardingTutorialState(), { type: "skip" });
    expect(advance(dismissed, {
      type: "thread-created",
      threadId: 7,
      interactionId: 11,
    })).toBe(dismissed);

    const complete = Object.freeze({
      phase: "complete",
      threadId: 7,
      interactionId: 12,
      target: null,
      reason: null,
    });
    expect(advance(complete, { type: "leave" })).toBe(complete);
  });
});
