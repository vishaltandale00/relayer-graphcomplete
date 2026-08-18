export {
  interactionForThread,
  responseNodesForThread,
} from "./product-workspace/model.js";

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
  state.interactions ??= [];
  state.nodes.push({
    id: interactionId,
    kind: "user-interaction",
    title,
    summary: prompt,
  });
  state.status = "idle";
  return thread;
}
