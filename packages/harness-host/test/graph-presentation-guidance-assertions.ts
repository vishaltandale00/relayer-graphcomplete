import { expect } from "vitest";

export function expectGraphPresentationGuidance(prompt: string): void {
  expect(prompt).toContain("Each layer should explain its scope as a coherent whole");
  expect(prompt).toContain('Choose "expand" when another layer should deepen one part');
  expect(prompt).toContain('Choose "reference" for supporting evidence or reusable context');
  expect(prompt).toContain('Choose "invoke" when the useful next step requires a new agent interaction');
  expect(prompt).toContain('choosing "stop" means leaving the node without a further action');
  expect(prompt).toContain("It is not GraphComplete's stopped lifecycle state");
}
