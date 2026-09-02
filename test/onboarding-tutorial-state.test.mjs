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

function waitingState() {
  return advance(createOnboardingTutorialState(), {
    type: "thread-created",
    threadId: 7,
    interactionId: 11,
  });
}

function activeState() {
  return advance(waitingState(), {
    type: "response-accepted",
    threadId: 7,
    interactionId: 11,
    layer: acceptedLayer({ actions: [
      { id: 31, kind: "navigate", sourceNodeId: "node-2", targetLayerId: 20 },
    ] }),
  });
}

describe("onboarding tutorial state", () => {
  it("walks the guided authoring lifecycle from question to completion", () => {
    expect(ONBOARDING_TUTORIAL_PROMPT, "ordinary tutorial question").toBe(
      "Why can time seem to pass faster as we get older?",
    );
    let tutorial = createOnboardingTutorialState();
    expect(tutorial, "initial composer state").toEqual({
      phase: "initial-composer",
      threadId: null,
      interactionId: null,
      target: null,
      reason: null,
    });
    expect(
      advance(tutorial, { type: "response-accepted", layer: acceptedLayer() }),
      "responses before thread creation are ignored",
    ).toBe(tutorial);

    tutorial = advance(tutorial, {
      type: "thread-created",
      threadId: "thread-7",
      interactionId: "turn-1",
    });
    expect(tutorial, "awaiting the first accepted response").toEqual({
      phase: "awaiting-accepted-response",
      threadId: "thread-7",
      interactionId: "turn-1",
      target: null,
      reason: null,
    });

    tutorial = advance(tutorial, {
      type: "response-accepted",
      threadId: "thread-7",
      interactionId: "turn-1",
      layer: acceptedLayer({ actions: [
        { id: 31, kind: "navigate", sourceNodeId: "node-2", targetLayerId: 20 },
      ] }),
    });
    expect(tutorial.phase, "node guidance begins").toBe("select-node");

    expect(advance(tutorial, {
      type: "node-selected", threadId: "thread-7", interactionId: "turn-1", nodeId: "node-1",
    }), "unrelated node selection is ignored").toBe(tutorial);
    tutorial = advance(tutorial, {
      type: "node-selected", threadId: "thread-7", interactionId: "turn-1", nodeId: "node-2",
    });
    expect(tutorial.phase, "action guidance begins").toBe("use-action");

    for (const [label, nodeId] of [
      ["inspector closes", null],
      ["inspector changes", "node-1"],
    ]) {
      tutorial = advance(tutorial, {
        type: "node-selected", threadId: "thread-7", interactionId: "turn-1", nodeId,
      });
      expect(tutorial.phase, `${label}: guidance returns to node selection`).toBe("select-node");
      expect(tutorial.target, `${label}: guidance target retained`).toEqual({
        nodeId: "node-2",
        actionId: 31,
        actionKind: "navigate",
      });
      tutorial = advance(tutorial, {
        type: "node-selected", threadId: "thread-7", interactionId: "turn-1", nodeId: "node-2",
      });
      expect(tutorial.phase, `${label}: action guidance resumes`).toBe("use-action");
    }

    expect(advance(tutorial, {
      type: "action-succeeded", threadId: "thread-7", interactionId: "turn-1", actionId: 99,
    }), "unrelated action success is ignored").toBe(tutorial);
    tutorial = advance(tutorial, {
      type: "action-succeeded", threadId: "thread-7", interactionId: "turn-1", actionId: "31",
    });
    expect(tutorial.phase, "follow-up guidance begins").toBe("write-follow-up");
    expect(tutorial.target, "follow-up guidance releases the target").toBeNull();

    tutorial = advance(tutorial, { type: "followup-submitted" });
    expect(tutorial.phase, "anonymous follow-up submission is ignored").toBe("write-follow-up");
    tutorial = advance(tutorial, {
      type: "followup-submitted", threadId: "thread-7", interactionId: "turn-2",
    });
    expect(tutorial, "tutorial completes with the follow-up interaction").toEqual({
      phase: "complete",
      threadId: "thread-7",
      interactionId: "turn-2",
      target: null,
      reason: null,
    });
    expect(advance(tutorial, { type: "leave" }), "completed state stays terminal").toBe(tutorial);
  });

  it("dismisses every disqualifying outcome without changing the thread", () => {
    const waiting = waitingState();
    const active = activeState();
    const dismissedShape = (reason) => ({
      phase: "dismissed",
      threadId: 7,
      interactionId: 11,
      target: null,
      reason,
    });

    expect(advance(waiting, {
      type: "response-accepted",
      threadId: 7,
      interactionId: 11,
      layer: acceptedLayer({ actions: [
        { id: "orphan", kind: "navigate", sourceNodeId: "missing-node", targetLayerId: 2 },
      ] }),
    }), "accepted response without a node-linked action dismisses").toEqual(dismissedShape("no-action"));

    for (const status of ["failed", "cancelled", "stopped"]) {
      expect(advance(waiting, {
        type: "response-terminal",
        threadId: 8,
        interactionId: 11,
        status,
      }), `${status} terminal from another thread is ignored`).toBe(waiting);
      expect(advance(waiting, {
        type: "response-terminal",
        threadId: 7,
        interactionId: 11,
        status,
      }), `${status} awaited response dismisses`).toEqual(dismissedShape(`response-${status}`));
    }

    for (const [type, reason] of [
      ["skip", "skipped"],
      ["leave", "left"],
      ["close", "closed"],
    ]) {
      expect(advance(active, { type }), `${type} ends the tutorial`).toEqual(dismissedShape(reason));
    }

    const dismissed = advance(createOnboardingTutorialState(), { type: "skip" });
    expect(advance(dismissed, {
      type: "thread-created",
      threadId: 7,
      interactionId: 11,
    }), "dismissed state stays terminal").toBe(dismissed);
  });

  it("selects the tutorial action from the candidate corpus by priority and exclusion", () => {
    const cases = [
      [
        "node-linked navigate beats earlier invokes",
        acceptedLayer({ actions: [
          { id: "invoke-1", kind: "invoke", sourceNodeId: "node-1", interactionText: "Go deeper" },
          { id: "navigate-1", kind: "navigate", sourceNodeId: "node-2", targetLayerId: 2 },
          { id: "navigate-orphan", kind: "navigate", sourceNodeId: "missing-node", targetLayerId: 3 },
        ] }),
        undefined,
        { nodeId: "node-2", actionId: "navigate-1", actionKind: "navigate" },
      ],
      [
        "malformed, invoked, and disabled candidates fall back to a ready invoke",
        acceptedLayer({ actions: [
          { id: "navigate-missing-target", kind: "navigate", sourceNodeId: "node-1" },
          { kind: "navigate", sourceNodeId: "node-1", targetLayerId: 2 },
          { id: "navigate-invoked", kind: "navigate", sourceNodeId: "node-1", targetLayerId: 3 },
          { id: "invoke-disabled", kind: "invoke", sourceNodeId: "node-1", interactionText: "One" },
          { id: "invoke-empty", kind: "invoke", sourceNodeId: "node-1", interactionText: "  " },
          { id: "invoke-ready", kind: "invoke", sourceNodeId: "node-2", interactionText: "Two" },
        ] }),
        {
          invokedActionIds: ["navigate-invoked"],
          disabledActionIds: new Set(["invoke-disabled"]),
        },
        { nodeId: "node-2", actionId: "invoke-ready", actionKind: "invoke" },
      ],
      [
        "resolved invokes fall back to an unresolved invoke",
        acceptedLayer({ actions: [
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
        ] }),
        undefined,
        { nodeId: "node-2", actionId: "invoke-ready", actionKind: "invoke" },
      ],
    ];
    expect(cases, "action selection corpus").toHaveLength(3);
    for (const [label, layer, options, expected] of cases) {
      expect(selectOnboardingTutorialAction(layer, options), label).toEqual(expected);
    }
  });

  it("follows the invoke fallback chain until navigation becomes available", () => {
    let tutorial = waitingState();

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
      expect(tutorial.phase, `invoke cycle ${actionId}: guidance starts`).toBe("select-node");
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
      expect(tutorial.phase, `invoke cycle ${actionId}: awaits the result interaction`).toBe(
        "awaiting-accepted-response",
      );
      expect(tutorial.interactionId, `invoke cycle ${actionId}: result interaction adopted`).toBe(
        resultInteractionId,
      );

      if (sourceInteractionId === 11) {
        expect(advance(tutorial, {
          type: "response-accepted",
          threadId: 7,
          interactionId: 11,
          layer: acceptedLayer({ actions: [{
            id: "navigate-stale",
            kind: "navigate",
            sourceNodeId: "node-2",
            targetLayerId: 20,
          }] }),
        }), "stale accepted interaction after an invoke is ignored").toBe(tutorial);
      }
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
    expect(tutorial.phase, "later navigation offer restarts node guidance").toBe("select-node");
    expect(tutorial.target.actionKind, "later navigation offer targets navigation").toBe("navigate");

    tutorial = advance(tutorial, {
      type: "node-selected", threadId: 7, interactionId: 13, nodeId: "node-2",
    });
    tutorial = advance(tutorial, {
      type: "action-succeeded", threadId: 7, interactionId: 13, actionId: "navigate-3",
    });
    expect(tutorial.phase, "navigation still required before the follow-up").toBe("write-follow-up");
  });
});
