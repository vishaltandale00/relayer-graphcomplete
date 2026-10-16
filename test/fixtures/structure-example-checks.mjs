import { expect } from "vitest";

// Observe the delivered fixture's accepted graph, not a quality quota for agents.
export async function expectStructureExample(root, loadLayer) {
  expect(root.nodes.map(node => node.title)).toEqual(["Result", "Why this follows", "Evidence and limits"]);
  const [result, reasoning, verification] = root.nodes;
  expect(root.edges.map(edge => [...edge.endpoints].sort((a,b)=>a-b))).toEqual([
    [result.id, reasoning.id].sort((a,b)=>a-b), [result.id, verification.id].sort((a,b)=>a-b),
  ]);
  const inspect = root.actions.find(action => action.label === "Inspect supporting evidence");
  expect(inspect).toMatchObject({ sourceNodeId: verification.id, kind: "navigate", relation: "expand" });
  expect(verification.authoredDetail.mounts).toEqual([
    expect.objectContaining({capability:expect.objectContaining({kind:"expand",action:expect.objectContaining({clientKey:inspect.clientKey})})}),
  ]);
  const support = await loadLayer(inspect.targetLayerId);
  expect(support.layer).toMatchObject({ id: inspect.targetLayerId, state: "accepted" });
  expect(support.layer.id).not.toBe(root.layer.id);
  expect(support.nodes).toHaveLength(1);
  expect(support.nodes[0]).toMatchObject({
    title: "Supporting evidence",
    detail: expect.stringContaining("actual check output, source extract or worked example"),
  });
  expect(support.nodes[0].authoredDetail).toBeDefined();
  expect(support.layer.defaultNodeId).toBe(support.nodes[0].id);
  expect(support.layer.layout.placements).toEqual([{ nodeId: support.nodes[0].id, x: 0.5, y: 0.5 }]);
}
