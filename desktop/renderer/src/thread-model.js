export function interactionForThread(state, thread) {
  return state.nodes.find((node) => node.id === thread?.rootNodeId);
}

export function responseNodesForThread(state, thread) {
  if (state.status !== "accepted") return [];
  const interaction = interactionForThread(state, thread);
  return state.nodes.filter((node) => (
    node.metadata?.relayer?.responseLayerOwnerNodeId === interaction?.id
  ));
}

export function addLocalThread(state, { selectedScope, prompt, title, createId }) {
  let projectId = selectedScope.projectId;
  if (selectedScope.kind === "folder") {
    projectId = createId();
    state.projects.push({
      id: projectId,
      name: selectedScope.label,
      path: selectedScope.path,
    });
  }
  const threadId = createId();
  const interactionId = createId();
  state.threads.forEach((thread) => { thread.active = false; });
  const thread = {
    id: threadId,
    title,
    rootNodeId: interactionId,
    projectId,
    active: true,
  };
  state.threads.push(thread);
  state.nodes.push({
    id: interactionId,
    kind: "user-interaction",
    title,
    summary: prompt,
  });
  state.status = "idle";
  return thread;
}
