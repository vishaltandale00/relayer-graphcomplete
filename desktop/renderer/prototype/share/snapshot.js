// PROTOTYPE - throwaway adapter from the real conversation-export v1 contract to
// the existing ProductWorkspace read model. The export remains local and is
// loaded at runtime by serve.mjs; no conversation content is committed here.

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid conversation export: ${message}`);
}

function resolvedLayer(view, layerId) {
  return view?.layers?.find(({ layer }) => String(layer?.id) === String(layerId)) ?? null;
}

function interactionFromTurn(turn, threadId) {
  const rootLayer = resolvedLayer(turn.acceptedView, turn.acceptedView?.rootLayerId);
  return {
    id: turn.id,
    threadId,
    sequence: turn.sequence,
    text: turn.text,
    createdAt: turn.createdAt,
    graphNodeId: turn.interactionNodeId ?? null,
    origin: turn.origin,
    contexts: (turn.contexts ?? []).map((context) => ({
      id: context.id,
      target: {
        nodeId: context.target.id,
        sourceInteractionNodeId: context.source.interactionNodeId,
        sourceLayerId: context.source.layerId,
      },
      targetNode: context.target,
      annotations: context.annotations ?? [],
    })),
    submittedInputs: turn.submittedInputs ?? [],
    completionStatus: turn.completion?.status ?? "not_started",
    harnessConfigurationName: turn.completion?.harnessConfigurationName ?? null,
    modelSelection: turn.completion?.modelSelection ?? null,
    completionOutput: turn.acceptedView ? {
      nodeId: turn.acceptedView.interactionNodeId,
      rootAction: turn.acceptedView.rootAction,
      rootLayer,
    } : null,
  };
}

export function parseConversationExport(jsonl) {
  const records = String(jsonl)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid conversation export: line ${index + 1} is not JSON (${error.message}).`);
      }
    });

  const [header, ...turns] = records;
  requireValue(header?.recordType === "header", "the first record must be a header");
  requireValue(header.exportVersion === 1, `expected exportVersion 1, received ${header.exportVersion}`);
  requireValue(turns.every((turn) => turn.recordType === "turn"), "every record after the header must be a turn");
  requireValue(turns.length === header.turns?.length, "turn count does not match the header manifest");

  const manifestMatches = turns.every((turn, index) => (
    String(turn.id) === String(header.turns[index]?.id)
    && Number(turn.sequence) === Number(header.turns[index]?.sequence)
  ));
  requireValue(manifestMatches, "turn order does not match the header manifest");

  const threadId = `export:${header.conversation.id}`;
  const projectId = header.conversation.projectName ? "export:project" : null;
  const interactions = turns.map((turn) => interactionFromTurn(turn, threadId));
  const acceptedTurns = turns.filter((turn) => (
    turn.completion?.status === "accepted"
    && turn.acceptedView
    && resolvedLayer(turn.acceptedView, turn.acceptedView.rootLayerId)
  ));
  const layersByTurn = new Map(turns.map((turn) => [
    String(turn.id),
    new Map((turn.acceptedView?.layers ?? []).map((layer) => [String(layer.layer.id), layer])),
  ]));

  return Object.freeze({
    header,
    turns,
    acceptedTurns,
    interactions,
    layersByTurn,
    thread: {
      id: threadId,
      title: header.conversation.title,
      projectId,
      rootInteractionId: interactions[0]?.id ?? null,
      harnessConfigurationName: header.conversation.harnessConfigurationName,
      permissionProfileId: header.conversation.permissionProfileId,
      createdAt: header.conversation.createdAt,
      updatedAt: turns.at(-1)?.createdAt ?? header.conversation.createdAt,
      imported: false,
      active: true,
    },
    projectName: header.conversation.projectName ?? null,
    layerFor(turnId, layerId) {
      return layersByTurn.get(String(turnId))?.get(String(layerId)) ?? null;
    },
    turnContainingLayer(layerId) {
      return turns.find((turn) => layersByTurn.get(String(turn.id))?.has(String(layerId))) ?? null;
    },
  });
}

export function scenarioInteractions(snapshot, scenario) {
  if (scenario === "no-accepted") {
    const source = snapshot.interactions[0];
    return [{
      ...source,
      id: "prototype:pending-only",
      sequence: 1,
      completionStatus: "running",
      completionOutput: null,
    }];
  }
  if (scenario === "active-response") {
    const last = snapshot.interactions.at(-1);
    return [...snapshot.interactions, {
      ...last,
      id: "prototype:active-response",
      sequence: Number(last?.sequence ?? 0) + 1,
      text: "A response is still being written. It must not enter the frozen share.",
      completionStatus: "running",
      completionOutput: null,
      contexts: [],
    }];
  }
  return [...snapshot.interactions];
}
