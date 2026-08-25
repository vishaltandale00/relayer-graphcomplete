export const ONBOARDING_TUTORIAL_PROMPT = "Why can time seem to pass faster as we get older?";

const DISMISS_EVENTS = Object.freeze({
  skip: "skipped",
  leave: "left",
  close: "closed",
});

function sameId(left, right) {
  return left != null && right != null && String(left) === String(right);
}

function state(phase, {
  threadId = null,
  interactionId = null,
  target = null,
  reason = null,
} = {}) {
  return Object.freeze({
    phase,
    threadId,
    interactionId,
    target: target == null ? null : Object.freeze({ ...target }),
    reason,
  });
}

export function createOnboardingTutorialState() {
  return state("initial-composer");
}

function idSet(ids) {
  return new Set(Array.from(ids ?? [], (id) => String(id)));
}

export function selectOnboardingTutorialAction(
  layer,
  { invokedActionIds, disabledActionIds } = {},
) {
  const nodes = Array.isArray(layer?.nodes) ? layer.nodes : [];
  const actions = Array.isArray(layer?.actions) ? layer.actions : [];
  const invoked = idSet(invokedActionIds);
  const disabled = idSet(disabledActionIds);
  const actionable = actions.filter((action) => (
    action?.id != null
    && nodes.some((node) => sameId(node?.id, action?.sourceNodeId))
    && !invoked.has(String(action.id))
    && !disabled.has(String(action.id))
    && (
      (action.kind === "navigate" && action.targetLayerId != null)
      || (
        action.kind === "invoke"
        && action.targetLayerId == null
        && typeof action.interactionText === "string"
        && action.interactionText.trim().length > 0
      )
    )
  ));
  const action = actionable.find((candidate) => candidate.kind === "navigate")
    ?? actionable[0];
  if (!action) return null;
  return Object.freeze({
    nodeId: action.sourceNodeId,
    actionId: action.id,
    actionKind: action.kind,
  });
}

export function reduceOnboardingTutorial(current, event) {
  if (!current || !event?.type) throw new TypeError("Tutorial state and event type are required.");
  if (current.phase === "complete" || current.phase === "dismissed") return current;

  const dismissReason = DISMISS_EVENTS[event.type];
  if (dismissReason) {
    return state("dismissed", {
      threadId: current.threadId,
      interactionId: current.interactionId,
      reason: dismissReason,
    });
  }

  switch (current.phase) {
    case "initial-composer":
      if (
        event.type !== "thread-created"
        || event.threadId == null
        || event.interactionId == null
      ) return current;
      return state("awaiting-accepted-response", {
        threadId: event.threadId,
        interactionId: event.interactionId,
      });

    case "awaiting-accepted-response": {
      const isAwaitedInteraction = sameId(event.threadId, current.threadId)
        && sameId(event.interactionId, current.interactionId);
      if (event.type === "response-terminal" && isAwaitedInteraction) {
        const terminalStatuses = new Set(["failed", "cancelled", "stopped"]);
        if (!terminalStatuses.has(event.status)) return current;
        return state("dismissed", {
          threadId: current.threadId,
          interactionId: current.interactionId,
          reason: `response-${event.status}`,
        });
      }
      if (event.type !== "response-accepted") return current;
      if (!isAwaitedInteraction) return current;
      const target = selectOnboardingTutorialAction(event.layer, {
        invokedActionIds: event.invokedActionIds,
        disabledActionIds: event.disabledActionIds,
      });
      if (!target) {
        return state("dismissed", {
          threadId: current.threadId,
          interactionId: current.interactionId,
          reason: "no-action",
        });
      }
      return state("select-node", {
        threadId: current.threadId,
        interactionId: current.interactionId,
        target,
      });
    }

    case "select-node":
      if (
        event.type !== "node-selected"
        || !sameId(event.threadId, current.threadId)
        || !sameId(event.interactionId, current.interactionId)
        || !sameId(event.nodeId, current.target?.nodeId)
      ) {
        return current;
      }
      return state("use-action", {
        threadId: current.threadId,
        interactionId: current.interactionId,
        target: current.target,
      });

    case "use-action":
      if (
        event.type === "node-selected"
        && sameId(event.threadId, current.threadId)
        && sameId(event.interactionId, current.interactionId)
        && !sameId(event.nodeId, current.target?.nodeId)
      ) {
        return state("select-node", {
          threadId: current.threadId,
          interactionId: current.interactionId,
          target: current.target,
        });
      }
      if (
        event.type !== "action-succeeded"
        || !sameId(event.threadId, current.threadId)
        || !sameId(event.interactionId, current.interactionId)
        || !sameId(event.actionId, current.target?.actionId)
      ) {
        return current;
      }
      if (current.target.actionKind === "navigate") {
        return state("write-follow-up", {
          threadId: current.threadId,
          interactionId: current.interactionId,
        });
      }
      if (event.resultInteractionId == null) return current;
      return state("awaiting-accepted-response", {
        threadId: current.threadId,
        interactionId: event.resultInteractionId,
      });

    case "write-follow-up":
      if (event.type !== "followup-submitted" || !sameId(event.threadId, current.threadId)) {
        return current;
      }
      return state("complete", {
        threadId: current.threadId,
        interactionId: event.interactionId ?? current.interactionId,
      });

    default:
      throw new TypeError(`Unknown tutorial phase: ${current.phase}`);
  }
}
